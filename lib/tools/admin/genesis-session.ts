import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { safeComponent } from "../../utils/safe-path.js";
import type {
  GenesisAnswers,
  GenesisAnswersJson,
  GenesisPayload,
  GenesisPhase,
  GenesisSessionContract,
  PipelineMetadata,
} from "../../intake/index.js";

const GENESIS_TOKEN_VERSION = 1;
const GENESIS_TOKEN_PREFIX = "g1";
const GENESIS_TOKEN_SECRET_FILE = ".commit-token-secret";

type CommitTokenPayload = {
  v: number;
  sid: string;
  iat: string;
  fp: string;
};

type LegacySessionEnvelope = {
  payload?: GenesisPayload;
};

export type NormalizedGenesisRequest = {
  phase: GenesisPhase;
  sessionId: string;
  rawIdea?: string;
  answers: GenesisAnswers;
  answersJson: GenesisAnswersJson;
  metadata: Pick<PipelineMetadata, "factory_change"> &
    Partial<Omit<PipelineMetadata, "factory_change" | "source">>;
  dryRun: boolean;
};

export type ValidatedCommitToken = {
  sessionId: string;
  issuedAt?: string;
  fingerprint: string | null;
  legacy: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error("Expected a string value");
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  throw new Error("factory_change must be a boolean");
}

function normalizeTimeoutMs(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error("timeout_ms must be a positive number");
  }
  return Math.max(1_000, Math.min(Math.trunc(numeric), 15 * 60 * 1000));
}

function parseAnswersJson(value: unknown): GenesisAnswersJson {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) {
      throw new Error("answers_json must decode to an object");
    }
    return parsed;
  }
  if (isRecord(value)) {
    return { ...value };
  }
  throw new Error("answers_json must be an object or a JSON object string");
}

function normalizeAnswers(value: unknown): GenesisAnswers {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new Error("answers must be an object");
  }
  return stringifyAnswerRecord(value);
}

function stringifyAnswerValue(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return "null";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? null : serialized;
}

function stringifyAnswerRecord(record: Record<string, unknown>): GenesisAnswers {
  const normalized: GenesisAnswers = {};
  for (const [key, value] of Object.entries(record)) {
    const serialized = stringifyAnswerValue(value);
    if (!serialized) continue;
    normalized[key] = serialized;
  }
  return normalized;
}

function deriveProjectName(repoUrl: string | null, projectName: string | null): string | null {
  if (projectName) return projectName;
  if (!repoUrl) return null;
  const sanitized = repoUrl.replace(/\/+$/, "");
  const lastSegment = sanitized.split("/").pop();
  if (!lastSegment) return null;
  return lastSegment.replace(/\.git$/i, "") || null;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function toBase64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function fromBase64Url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf-8");
}

function getSessionsDir(workspaceDir: string): string {
  return join(workspaceDir, "genesis-sessions");
}

function getSessionFilePath(workspaceDir: string, sessionId: string): string {
  safeComponent(sessionId); // Throws if sessionId contains /, \, .., or null bytes
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error(`Invalid session ID format: ${sessionId}`);
  }
  return join(getSessionsDir(workspaceDir), `${sessionId}.json`);
}

function ensureSessionsDir(workspaceDir: string): string {
  const sessionsDir = getSessionsDir(workspaceDir);
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }
  return sessionsDir;
}

function readOrCreateSecret(workspaceDir: string): Buffer {
  const sessionsDir = ensureSessionsDir(workspaceDir);
  const secretPath = join(sessionsDir, GENESIS_TOKEN_SECRET_FILE);
  if (existsSync(secretPath)) {
    return Buffer.from(readFileSync(secretPath, "utf-8"), "utf-8");
  }
  const secret = toBase64Url(randomBytes(32));
  writeFileSync(secretPath, secret, { encoding: "utf-8", mode: 0o600 });
  return Buffer.from(secret, "utf-8");
}

function fingerprintInput(payload: GenesisPayload): string {
  const material = {
    session_id: payload.session_id,
    raw_idea: payload.raw_idea,
    answers: payload.answers,
    metadata: {
      repo_url: payload.metadata.repo_url ?? null,
      project_name: payload.metadata.project_name ?? null,
      stack_hint: payload.metadata.stack_hint ?? null,
      command: payload.metadata.command ?? null,
      timeout_ms: payload.metadata.timeout_ms ?? null,
      factory_change: payload.metadata.factory_change,
      answers_json: payload.metadata.answers_json ?? {},
    },
    classification: payload.classification ?? null,
    spec: payload.spec ?? null,
  };
  return createHash("sha256").update(stableSerialize(material)).digest("hex");
}

function buildSessionContract(
  payload: GenesisPayload,
  phase: GenesisPhase,
  discoverComplete: boolean,
): GenesisSessionContract {
  return {
    version: GENESIS_TOKEN_VERSION,
    discover_complete: discoverComplete,
    persisted_at: new Date().toISOString(),
    input_fingerprint: fingerprintInput(payload),
    phase,
  };
}

function signCommitToken(secret: Buffer, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function normalizeGenesisRequest(
  params: Record<string, unknown>,
  existingPayload?: GenesisPayload,
): NormalizedGenesisRequest {
  const command = normalizeOptionalString(params.command) ?? existingPayload?.metadata.command ?? null;
  const explicitPhase = normalizeOptionalString(params.phase)?.toLowerCase() ?? null;
  const commandPhase = command?.toLowerCase() ?? null;
  const phaseCandidate =
    explicitPhase ??
    (commandPhase && (commandPhase === "discover" || commandPhase === "commit") ? commandPhase : null);
  if (phaseCandidate !== "discover" && phaseCandidate !== "commit") {
    throw new Error('phase is required and must be "discover" or "commit"');
  }

  const repoUrl = normalizeOptionalString(params.repo_url) ?? existingPayload?.metadata.repo_url ?? null;
  const projectName =
    deriveProjectName(
      repoUrl,
      normalizeOptionalString(params.project_name) ?? existingPayload?.metadata.project_name ?? null,
    );
  const answersJson = {
    ...(existingPayload?.metadata.answers_json ?? {}),
    ...parseAnswersJson(params.answers_json),
  };
  const answers = {
    ...(existingPayload?.answers ?? {}),
    ...stringifyAnswerRecord(answersJson),
    ...normalizeAnswers(params.answers),
  };
  const stackHint =
    normalizeOptionalString(params.stack) ??
    normalizeOptionalString((params as Record<string, unknown>).stack_hint) ??
    existingPayload?.metadata.stack_hint ??
    null;
  const timeoutMs = normalizeTimeoutMs(params.timeout_ms) ?? existingPayload?.metadata.timeout_ms ?? null;
  const dryRun =
    typeof params.dry_run === "boolean"
      ? params.dry_run
      : existingPayload?.dry_run ?? false;

  return {
    phase: phaseCandidate,
    sessionId:
      normalizeOptionalString(params.session_id) ??
      existingPayload?.session_id ??
      randomUUID(),
    rawIdea:
      normalizeOptionalString(params.idea) ??
      command ??
      (existingPayload?.raw_idea ? existingPayload.raw_idea : undefined),
    answers,
    answersJson,
    metadata: {
      repo_url: repoUrl,
      project_name: projectName,
      stack_hint: stackHint,
      command,
      timeout_ms: timeoutMs,
      answers_json: answersJson,
      factory_change: normalizeBoolean(params.factory_change, existingPayload?.metadata.factory_change ?? false),
    },
    dryRun,
  };
}

export function saveGenesisSession(
  workspaceDir: string,
  payload: GenesisPayload,
  phase: GenesisPhase,
  discoverComplete: boolean,
): GenesisPayload {
  ensureSessionsDir(workspaceDir);
  const sessionPayload: GenesisPayload = {
    ...payload,
    metadata: {
      ...payload.metadata,
      genesis_contract: buildSessionContract(payload, phase, discoverComplete),
    },
  };
  writeFileSync(
    getSessionFilePath(workspaceDir, sessionPayload.session_id),
    JSON.stringify(sessionPayload, null, 2),
    "utf-8",
  );
  return sessionPayload;
}

export function loadGenesisSession(workspaceDir: string, sessionId: string): GenesisPayload | null {
  const sessionFile = getSessionFilePath(workspaceDir, sessionId);
  if (!existsSync(sessionFile)) return null;
  const parsed = JSON.parse(readFileSync(sessionFile, "utf-8")) as GenesisPayload | LegacySessionEnvelope;
  if (parsed && typeof parsed === "object" && "payload" in parsed && parsed.payload) {
    return parsed.payload;
  }
  return parsed as GenesisPayload;
}

export function issueCommitToken(workspaceDir: string, payload: GenesisPayload): string {
  const fingerprint = payload.metadata.genesis_contract?.input_fingerprint ?? fingerprintInput(payload);
  const tokenPayload: CommitTokenPayload = {
    v: GENESIS_TOKEN_VERSION,
    sid: payload.session_id,
    iat: new Date().toISOString(),
    fp: fingerprint,
  };
  const secret = readOrCreateSecret(workspaceDir);
  const body = toBase64Url(JSON.stringify(tokenPayload));
  const signature = signCommitToken(secret, body);
  return `${GENESIS_TOKEN_PREFIX}.${body}.${signature}`;
}

function safeEqualStrings(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf-8");
  const rightBuffer = Buffer.from(right, "utf-8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseLegacyCommitToken(token: string): ValidatedCommitToken | null {
  try {
    const decoded = JSON.parse(Buffer.from(token, "base64").toString("utf-8")) as {
      session_id?: unknown;
      timestamp?: unknown;
    };
    if (typeof decoded.session_id !== "string" || !decoded.session_id.trim()) {
      return null;
    }
    return {
      sessionId: decoded.session_id,
      issuedAt: typeof decoded.timestamp === "string" ? decoded.timestamp : undefined,
      fingerprint: null,
      legacy: true,
    };
  } catch {
    return null;
  }
}

export function validateCommitToken(workspaceDir: string, commitToken: string): ValidatedCommitToken {
  const trimmed = commitToken.trim();
  const parts = trimmed.split(".");
  if (parts.length === 3 && parts[0] === GENESIS_TOKEN_PREFIX) {
    const [, body, signature] = parts;
    const secret = readOrCreateSecret(workspaceDir);
    const expectedSignature = signCommitToken(secret, body);
    if (!safeEqualStrings(expectedSignature, signature)) {
      throw new Error("Invalid commit_token signature");
    }
    const decoded = JSON.parse(fromBase64Url(body)) as CommitTokenPayload;
    if (
      decoded.v !== GENESIS_TOKEN_VERSION ||
      typeof decoded.sid !== "string" ||
      !decoded.sid.trim() ||
      typeof decoded.fp !== "string" ||
      !decoded.fp
    ) {
      throw new Error("Invalid commit_token payload");
    }
    return {
      sessionId: decoded.sid,
      issuedAt: decoded.iat,
      fingerprint: decoded.fp,
      legacy: false,
    };
  }

  const legacy = parseLegacyCommitToken(trimmed);
  if (legacy) return legacy;
  throw new Error("Invalid commit_token format");
}

export function ensureCommitReady(
  workspaceDir: string,
  commitToken: string,
  explicitSessionId?: string | null,
): GenesisPayload {
  const token = validateCommitToken(workspaceDir, commitToken);
  if (explicitSessionId && explicitSessionId !== token.sessionId) {
    throw new Error("session_id does not match commit_token");
  }
  const storedPayload = loadGenesisSession(workspaceDir, token.sessionId);
  if (!storedPayload) {
    throw new Error(`No stored discover session found for ${token.sessionId}`);
  }
  const contract = storedPayload.metadata.genesis_contract;
  if ((contract && !contract.discover_complete) || !storedPayload.spec) {
    throw new Error("Discover session is not ready for commit");
  }
  const recomputedFingerprint = fingerprintInput(storedPayload);
  if (contract?.input_fingerprint && contract.input_fingerprint !== recomputedFingerprint) {
    throw new Error("Stored discover session was modified after token issuance");
  }
  const currentFingerprint = recomputedFingerprint;
  if (!token.legacy && token.fingerprint && currentFingerprint !== token.fingerprint) {
    throw new Error("commit_token does not match the stored discover session");
  }
  return storedPayload;
}
