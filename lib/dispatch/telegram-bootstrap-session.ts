import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../setup/constants.js";
import type { PipelineArtifact } from "../intake/types.js";

export type TelegramBootstrapStatus =
  | "pending_classify"  // session created, LLM classification not yet started
  | "received"
  | "classifying"       // LLM classification in progress
  | "bootstrapping"
  | "clarifying"
  | "provisioning_repo"
  | "creating_topic"
  | "registering_project"
  | "creating_issue"
  | "dispatching"
  | "completed"
  | "failed"
  | "orphaned_repo";

export type TelegramBootstrapStep =
  | "awaiting_ack"
  | "awaiting_pipeline"
  | "project_registered"
  | "topic_kickoff_sent"
  | "project_ticked"
  | "completion_ack_sent"
  | "completed";

type TelegramBootstrapRoute = {
  channel: string;
  channelId: string;
  messageThreadId?: number | null;
  accountId?: string | null;
};

export type TelegramBootstrapSession = {
  id: string;
  conversationId: string;
  sourceChannel: string;
  sourceRoute?: TelegramBootstrapRoute | null;
  projectRoute?: TelegramBootstrapRoute | null;
  requestHash: string;
  requestFingerprint?: string | null;
  lastCompletedRequestHash?: string | null;
  rawIdea: string;
  projectName?: string | null;
  stackHint?: string | null;
  repoUrl?: string | null;
  repoPath?: string | null;
  projectSlug?: string | null;
  issueId?: number | null;
  messageThreadId?: number | null;
  projectChannelId?: string | null;
  status: TelegramBootstrapStatus;
  attemptId?: string | null;
  attemptSeq?: number | null;
  classifySessionKey?: string | null;
  classifyRunId?: string | null;
  classifyStartedAt?: string | null;
  bootstrapStep?: TelegramBootstrapStep | null;
  attemptCount?: number | null;
  lastError?: string | null;
  nextRetryAt?: string | null;
  ackSentAt?: string | null;
  projectRegisteredAt?: string | null;
  topicKickoffSentAt?: string | null;
  projectTickedAt?: string | null;
  completionAckSentAt?: string | null;
  pendingClarification?: "stack" | "stack_and_name" | "name" | "scope" | null;
  orphanedArtifacts?: PipelineArtifact[] | null;
  createdAt: string;
  updatedAt: string;
  suppressUntil: string;
  language?: "pt" | "en";
  error?: string | null;
};

export type TelegramBootstrapAttemptSnapshot = Pick<
  TelegramBootstrapSession,
  "conversationId" | "attemptId" | "attemptSeq" | "requestHash" | "status" | "updatedAt"
>;

type BootstrapCheckpointWriteDecision = { ok: true } | { ok: false; reason: "stale_regression" };

const SESSION_TTL_MS = 10 * 60_000;
const CLASSIFYING_TTL_MS = 15_000; // 15s — matches LLM timeout
const RELEASED_CLASSIFY_ERRORS = new Set([
  "classify_invalid_result",
  "classify_low_confidence",
  "classify_not_project",
  "classify_result_expired",
]);

export function toCanonicalTelegramBootstrapConversationId(conversationId: string): string {
  const trimmed = conversationId.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith("telegram:") ? trimmed : `telegram:${trimmed}`;
}

function sessionsDir(workspaceDir: string): string {
  return path.join(workspaceDir, DATA_DIR, "bootstrap-sessions");
}

function sessionPath(workspaceDir: string, conversationId: string): string {
  return path.join(
    sessionsDir(workspaceDir),
    `${toCanonicalTelegramBootstrapConversationId(conversationId)}.json`,
  );
}

function alternateSessionPath(workspaceDir: string, conversationId: string): string | null {
  const canonical = toCanonicalTelegramBootstrapConversationId(conversationId);
  const bare = canonical.startsWith("telegram:") ? canonical.slice("telegram:".length) : canonical;
  if (!bare || bare === canonical) return null;
  return path.join(sessionsDir(workspaceDir), `${bare}.json`);
}

function normalizeStoredSession(session: TelegramBootstrapSession): TelegramBootstrapSession {
  const canonicalConversationId = toCanonicalTelegramBootstrapConversationId(session.conversationId);
  if (canonicalConversationId === session.conversationId) {
    return session;
  }
  return {
    ...session,
    id: buildBootstrapSessionId(canonicalConversationId, session.rawIdea),
    conversationId: canonicalConversationId,
  };
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function buildBootstrapSessionId(
  conversationId: string,
  rawIdea: string,
): string {
  return `tgdm-${conversationId}-${stableHash(rawIdea.trim().toLowerCase())}`;
}

export function buildBootstrapRequestFingerprint(input: {
  rawIdea: string;
  projectName?: string | null;
  stackHint?: string | null;
  repoUrl?: string | null;
  repoPath?: string | null;
}): string {
  return stableHash(JSON.stringify({
    rawIdea: input.rawIdea.trim().toLowerCase(),
    projectName: input.projectName?.trim().toLowerCase() || null,
    stackHint: input.stackHint?.trim().toLowerCase() || null,
    repoUrl: input.repoUrl?.trim().toLowerCase() || null,
    repoPath: input.repoPath?.trim().toLowerCase() || null,
  }));
}

export function buildBootstrapRequestHash(input: {
  rawIdea: string;
  projectName?: string | null;
  stackHint?: string | null;
  repoUrl?: string | null;
  repoPath?: string | null;
}): string {
  return buildBootstrapRequestFingerprint(input);
}

function nextSuppressUntil(status?: TelegramBootstrapStatus): string {
  const ttl = (status === "classifying" || status === "pending_classify")
    ? CLASSIFYING_TTL_MS
    : SESSION_TTL_MS;
  return new Date(Date.now() + ttl).toISOString();
}

function isReleasedClassifyFailure(error: string | null | undefined): boolean {
  return Boolean(error && RELEASED_CLASSIFY_ERRORS.has(error));
}

function resolveNullableField<T>(
  inputValue: T | null | undefined,
  existingValue: T | null | undefined,
  fallback: T | null = null,
): T | null {
  return inputValue !== undefined ? inputValue : existingValue ?? fallback;
}

function defaultNextRetryAtForStatus(
  status: TelegramBootstrapStatus,
  existingValue: string | null | undefined,
): string | null {
  if (status === "bootstrapping" || status === "dispatching") {
    return existingValue ?? null;
  }
  return null;
}

const MONOTONIC_BOOTSTRAP_FIELDS: Array<
  keyof Pick<
    TelegramBootstrapSession,
    "ackSentAt" | "projectRegisteredAt" | "topicKickoffSentAt" | "projectTickedAt" | "completionAckSentAt"
  >
> = [
  "ackSentAt",
  "projectRegisteredAt",
  "topicKickoffSentAt",
  "projectTickedAt",
  "completionAckSentAt",
];

export function shouldPersistBootstrapCheckpoint(
  current: TelegramBootstrapSession | null | undefined,
  next: TelegramBootstrapSession,
): BootstrapCheckpointWriteDecision {
  if (!current) return { ok: true };
  if (current.conversationId !== next.conversationId) return { ok: true };

  const currentAttemptSeq = current.attemptSeq ?? null;
  const nextAttemptSeq = next.attemptSeq ?? null;
  if (
    currentAttemptSeq != null &&
    nextAttemptSeq != null &&
    nextAttemptSeq < currentAttemptSeq
  ) {
    return { ok: false, reason: "stale_regression" };
  }

  const sameAttempt = Boolean(
    current.attemptId &&
    next.attemptId &&
    current.attemptSeq != null &&
    next.attemptSeq != null &&
    current.attemptId === next.attemptId &&
    current.attemptSeq === next.attemptSeq,
  );

  if (!sameAttempt) return { ok: true };

  for (const field of MONOTONIC_BOOTSTRAP_FIELDS) {
    if (current[field] && !next[field]) {
      return { ok: false, reason: "stale_regression" };
    }
  }

  return { ok: true };
}

export async function readTelegramBootstrapSession(
  workspaceDir: string,
  conversationId: string,
): Promise<TelegramBootstrapSession | null> {
  const canonicalConversationId = toCanonicalTelegramBootstrapConversationId(conversationId);
  const paths = [
    sessionPath(workspaceDir, canonicalConversationId),
    alternateSessionPath(workspaceDir, conversationId),
  ].filter((entry): entry is string => Boolean(entry));

  try {
    for (const candidatePath of paths) {
      try {
        const raw = await fs.readFile(candidatePath, "utf-8");
        const session = normalizeStoredSession(JSON.parse(raw) as TelegramBootstrapSession);
        if (session.status === "failed" && isReleasedClassifyFailure(session.error)) {
          await deleteTelegramBootstrapSession(workspaceDir, canonicalConversationId);
          return null;
        }
        return session;
      } catch (error: any) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
    }
    return null;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function deleteTelegramBootstrapSession(
  workspaceDir: string,
  conversationId: string,
): Promise<void> {
  await fs.unlink(sessionPath(workspaceDir, conversationId)).catch(() => {});
  const legacyPath = alternateSessionPath(workspaceDir, conversationId);
  if (legacyPath) {
    await fs.unlink(legacyPath).catch(() => {});
  }
}

export async function expireTelegramBootstrapSession(
  workspaceDir: string,
  conversationId: string,
): Promise<TelegramBootstrapSession | null> {
  const session = await readTelegramBootstrapSession(workspaceDir, conversationId);
  if (!session) return null;

  const expiredSession: TelegramBootstrapSession = {
    ...session,
    updatedAt: new Date().toISOString(),
    suppressUntil: new Date(0).toISOString(),
  };

  await writeTelegramBootstrapSession(workspaceDir, expiredSession);
  return expiredSession;
}

export async function cleanupTelegramBootstrapSession(
  workspaceDir: string,
  conversationId: string,
): Promise<boolean> {
  const session = await readTelegramBootstrapSession(workspaceDir, conversationId);
  if (!session) return false;
  await deleteTelegramBootstrapSession(workspaceDir, conversationId);
  return true;
}

export async function writeTelegramBootstrapSession(
  workspaceDir: string,
  session: TelegramBootstrapSession,
): Promise<void> {
  const canonicalSession = normalizeStoredSession(session);
  const dir = sessionsDir(workspaceDir);
  await fs.mkdir(dir, { recursive: true });
  const file = sessionPath(workspaceDir, canonicalSession.conversationId);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(canonicalSession, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, file);
  const legacyPath = alternateSessionPath(workspaceDir, session.conversationId);
  if (legacyPath) {
    await fs.unlink(legacyPath).catch(() => {});
  }
}

export async function upsertTelegramBootstrapSession(
  workspaceDir: string,
  input: {
    conversationId: string;
    sourceChannel?: string;
    sourceRoute?: TelegramBootstrapRoute | null;
    projectRoute?: TelegramBootstrapRoute | null;
    rawIdea: string;
    projectName?: string | null;
    stackHint?: string | null;
    repoUrl?: string | null;
    repoPath?: string | null;
    status: TelegramBootstrapStatus;
    pendingClarification?: "stack" | "stack_and_name" | "name" | "scope" | null;
    orphanedArtifacts?: PipelineArtifact[] | null;
    error?: string | null;
    projectSlug?: string | null;
    issueId?: number | null;
    messageThreadId?: number | null;
    projectChannelId?: string | null;
    language?: "pt" | "en";
    attemptCount?: number | null;
    attemptId?: string | null;
    attemptSeq?: number | null;
    classifySessionKey?: string | null;
    classifyRunId?: string | null;
    classifyStartedAt?: string | null;
    bootstrapStep?: TelegramBootstrapStep | null;
    lastError?: string | null;
    nextRetryAt?: string | null;
    ackSentAt?: string | null;
    projectRegisteredAt?: string | null;
    topicKickoffSentAt?: string | null;
    projectTickedAt?: string | null;
    completionAckSentAt?: string | null;
  },
): Promise<TelegramBootstrapSession> {
  const conversationId = toCanonicalTelegramBootstrapConversationId(input.conversationId);
  const existing = await readTelegramBootstrapSession(workspaceDir, conversationId);
  const resolvedSourceRoute = resolveNullableField(input.sourceRoute, existing?.sourceRoute);
  const resolvedProjectRoute = resolveNullableField(input.projectRoute, existing?.projectRoute);
  const resolvedProjectName = resolveNullableField(input.projectName, existing?.projectName);
  const resolvedStackHint = resolveNullableField(input.stackHint, existing?.stackHint);
  const resolvedRepoUrl = resolveNullableField(input.repoUrl, existing?.repoUrl);
  const resolvedRepoPath = resolveNullableField(input.repoPath, existing?.repoPath);
  const resolvedProjectSlug = resolveNullableField(input.projectSlug, existing?.projectSlug);
  const resolvedIssueId = resolveNullableField(input.issueId, existing?.issueId);
  const resolvedMessageThreadId = resolveNullableField(input.messageThreadId, existing?.messageThreadId);
  const resolvedProjectChannelId = resolveNullableField(input.projectChannelId, existing?.projectChannelId);
  const resolvedAttemptCount = resolveNullableField(input.attemptCount, existing?.attemptCount, 0);
  const resolvedAttemptId = resolveNullableField(input.attemptId, existing?.attemptId);
  const resolvedAttemptSeq = resolveNullableField(input.attemptSeq, existing?.attemptSeq);
  const resolvedClassifySessionKey = resolveNullableField(input.classifySessionKey, existing?.classifySessionKey);
  const resolvedClassifyRunId = resolveNullableField(input.classifyRunId, existing?.classifyRunId);
  const resolvedClassifyStartedAt = resolveNullableField(input.classifyStartedAt, existing?.classifyStartedAt);
  const resolvedBootstrapStep = resolveNullableField(input.bootstrapStep, existing?.bootstrapStep);
  const resolvedNextRetryAt =
    input.nextRetryAt !== undefined
      ? input.nextRetryAt
      : defaultNextRetryAtForStatus(input.status, existing?.nextRetryAt);
  const resolvedAckSentAt = resolveNullableField(input.ackSentAt, existing?.ackSentAt);
  const resolvedProjectRegisteredAt = resolveNullableField(input.projectRegisteredAt, existing?.projectRegisteredAt);
  const resolvedTopicKickoffSentAt = resolveNullableField(input.topicKickoffSentAt, existing?.topicKickoffSentAt);
  const resolvedProjectTickedAt = resolveNullableField(input.projectTickedAt, existing?.projectTickedAt);
  const resolvedCompletionAckSentAt = resolveNullableField(input.completionAckSentAt, existing?.completionAckSentAt);
  const resolvedError =
    input.error !== undefined
      ? input.error
      : input.lastError !== undefined
        ? input.lastError
        : existing?.error ?? existing?.lastError ?? null;
  const requestHash = buildBootstrapRequestHash({
    rawIdea: input.rawIdea,
    projectName: resolvedProjectName,
    stackHint: resolvedStackHint,
    repoUrl: resolvedRepoUrl,
    repoPath: resolvedRepoPath,
  });
  const now = new Date().toISOString();
  const session: TelegramBootstrapSession = {
    id: existing?.id ?? buildBootstrapSessionId(conversationId, input.rawIdea),
    conversationId,
    sourceChannel: input.sourceChannel ?? input.sourceRoute?.channel ?? existing?.sourceChannel ?? "telegram",
    sourceRoute: resolvedSourceRoute,
    projectRoute: resolvedProjectRoute,
    requestHash,
    requestFingerprint: requestHash,
    lastCompletedRequestHash:
      input.status === "completed"
        ? requestHash
        : existing?.lastCompletedRequestHash ?? null,
    rawIdea: input.rawIdea,
    projectName: resolvedProjectName,
    stackHint: resolvedStackHint,
    repoUrl: resolvedRepoUrl,
    repoPath: resolvedRepoPath,
    projectSlug: resolvedProjectSlug,
    issueId: resolvedIssueId,
    messageThreadId: resolvedMessageThreadId,
    projectChannelId: resolvedProjectChannelId,
    language: input.language ?? existing?.language,
    status: input.status,
    attemptId: resolvedAttemptId,
    attemptSeq: resolvedAttemptSeq,
    classifySessionKey: resolvedClassifySessionKey,
    classifyRunId: resolvedClassifyRunId,
    classifyStartedAt: resolvedClassifyStartedAt,
    bootstrapStep: resolvedBootstrapStep,
    attemptCount: resolvedAttemptCount,
    lastError: resolvedError,
    nextRetryAt: resolvedNextRetryAt,
    ackSentAt: resolvedAckSentAt,
    projectRegisteredAt: resolvedProjectRegisteredAt,
    topicKickoffSentAt: resolvedTopicKickoffSentAt,
    projectTickedAt: resolvedProjectTickedAt,
    completionAckSentAt: resolvedCompletionAckSentAt,
    pendingClarification: input.pendingClarification !== undefined
      ? input.pendingClarification
      : existing?.pendingClarification ?? null,
    orphanedArtifacts: input.orphanedArtifacts !== undefined
      ? input.orphanedArtifacts
      : existing?.orphanedArtifacts ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    suppressUntil: nextSuppressUntil(input.status),
    error: resolvedError,
  };
  const writeDecision = shouldPersistBootstrapCheckpoint(existing, session);
  if (!writeDecision.ok && existing) {
    return existing;
  }
  await writeTelegramBootstrapSession(workspaceDir, session);
  return session;
}

export function shouldSuppressTelegramBootstrapReply(
  session: TelegramBootstrapSession | null,
  request?: {
    rawIdea: string;
    projectName?: string | null;
    stackHint?: string | null;
    repoUrl?: string | null;
    repoPath?: string | null;
  } | null,
): boolean {
  if (!session) return false;
  if (isTelegramBootstrapSessionExpired(session)) return false;
  if (session.status === "completed" || session.status === "failed") {
    if (session.status === "failed" && isReleasedClassifyFailure(session.error)) return false;
    if (!request) return false;
    return buildBootstrapRequestFingerprint(request) === session.requestHash;
  }
  if (!request) return true;
  return buildBootstrapRequestFingerprint(request) === session.requestHash;
}

export function isTelegramBootstrapSessionExpired(
  session: TelegramBootstrapSession | null | undefined,
  now = Date.now(),
): boolean {
  if (!session) return false;
  const suppressUntil = Date.parse(session.suppressUntil);
  return !Number.isNaN(suppressUntil) && suppressUntil < now;
}

export function isRecoverableTelegramBootstrapSession(
  session: TelegramBootstrapSession | null | undefined,
): session is TelegramBootstrapSession & { status: "bootstrapping" | "dispatching" } {
  return session?.status === "bootstrapping" || session?.status === "dispatching";
}

export function isClaimableTelegramBootstrapSession(
  session: TelegramBootstrapSession | null | undefined,
  now = Date.now(),
): session is TelegramBootstrapSession & { status: "bootstrapping" | "dispatching" } {
  if (!isRecoverableTelegramBootstrapSession(session)) return false;
  if (!session.nextRetryAt) return true;
  const retryAt = Date.parse(session.nextRetryAt);
  return Number.isNaN(retryAt) || retryAt <= now;
}

export function isSupersededTelegramBootstrapAttempt(
  current: TelegramBootstrapSession | null | undefined,
  candidate: TelegramBootstrapAttemptSnapshot | null | undefined,
): boolean {
  if (!current || !candidate) return false;
  if (current.conversationId !== candidate.conversationId) return true;

  const currentHasAttempt = current.attemptId != null && current.attemptSeq != null;
  const candidateHasAttempt = candidate.attemptId != null && candidate.attemptSeq != null;
  if (currentHasAttempt || candidateHasAttempt) {
    return current.attemptId !== candidate.attemptId || current.attemptSeq !== candidate.attemptSeq;
  }

  return (
    current.requestHash !== candidate.requestHash ||
    current.status !== candidate.status ||
    current.updatedAt !== candidate.updatedAt
  );
}
