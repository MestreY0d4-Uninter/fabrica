import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../setup/migrate-layout.js";
import type { PipelineArtifact } from "../intake/types.js";

export type TelegramBootstrapStatus =
  | "pending_classify"  // session created, LLM classification not yet started
  | "received"
  | "classifying"       // LLM classification in progress
  | "clarifying"
  | "provisioning_repo"
  | "creating_topic"
  | "registering_project"
  | "creating_issue"
  | "dispatching"
  | "completed"
  | "failed"
  | "orphaned_repo";

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
  pendingClarification?: "stack" | "stack_and_name" | "name" | null;
  orphanedArtifacts?: PipelineArtifact[] | null;
  createdAt: string;
  updatedAt: string;
  suppressUntil: string;
  language?: "pt" | "en";
  error?: string | null;
};

const SESSION_TTL_MS = 10 * 60_000;
const CLASSIFYING_TTL_MS = 15_000; // 15s — matches LLM timeout

function sessionsDir(workspaceDir: string): string {
  return path.join(workspaceDir, DATA_DIR, "bootstrap-sessions");
}

function sessionPath(workspaceDir: string, conversationId: string): string {
  return path.join(sessionsDir(workspaceDir), `${conversationId}.json`);
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

export async function readTelegramBootstrapSession(
  workspaceDir: string,
  conversationId: string,
): Promise<TelegramBootstrapSession | null> {
  try {
    const raw = await fs.readFile(sessionPath(workspaceDir, conversationId), "utf-8");
    const session = JSON.parse(raw) as TelegramBootstrapSession;
    // Auto-cleanup expired clarifying/classifying sessions so they don't block new requests (A4).
    // A session stuck in "clarifying" or "classifying" past its suppressUntil TTL will never
    // be resolved — remove it from disk so the next message starts fresh.
    if ((session.status === "clarifying" || session.status === "classifying" || session.status === "pending_classify") && Date.parse(session.suppressUntil) < Date.now()) {
      await fs.unlink(sessionPath(workspaceDir, conversationId)).catch(() => {});
      return null;
    }
    return session;
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
}

export async function writeTelegramBootstrapSession(
  workspaceDir: string,
  session: TelegramBootstrapSession,
): Promise<void> {
  const dir = sessionsDir(workspaceDir);
  await fs.mkdir(dir, { recursive: true });
  const file = sessionPath(workspaceDir, session.conversationId);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(session, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, file);
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
    pendingClarification?: "stack" | "stack_and_name" | "name" | null;
    orphanedArtifacts?: PipelineArtifact[] | null;
    error?: string | null;
    projectSlug?: string | null;
    issueId?: number | null;
    messageThreadId?: number | null;
    projectChannelId?: string | null;
    language?: "pt" | "en";
  },
): Promise<TelegramBootstrapSession> {
  const existing = await readTelegramBootstrapSession(workspaceDir, input.conversationId);
  const requestHash = buildBootstrapRequestHash({
    rawIdea: input.rawIdea,
    projectName: input.projectName,
    stackHint: input.stackHint,
    repoUrl: input.repoUrl,
    repoPath: input.repoPath,
  });
  const now = new Date().toISOString();
  const session: TelegramBootstrapSession = {
    id: existing?.id ?? buildBootstrapSessionId(input.conversationId, input.rawIdea),
    conversationId: input.conversationId,
    sourceChannel: input.sourceChannel ?? input.sourceRoute?.channel ?? existing?.sourceChannel ?? "telegram",
    sourceRoute: input.sourceRoute ?? existing?.sourceRoute ?? null,
    projectRoute: input.projectRoute ?? existing?.projectRoute ?? null,
    requestHash,
    requestFingerprint: requestHash,
    lastCompletedRequestHash:
      input.status === "completed"
        ? requestHash
        : existing?.lastCompletedRequestHash ?? null,
    rawIdea: input.rawIdea,
    projectName: input.projectName ?? existing?.projectName ?? null,
    stackHint: input.stackHint ?? existing?.stackHint ?? null,
    repoUrl: input.repoUrl ?? existing?.repoUrl ?? null,
    repoPath: input.repoPath ?? existing?.repoPath ?? null,
    projectSlug: input.projectSlug ?? existing?.projectSlug ?? null,
    issueId: input.issueId ?? existing?.issueId ?? null,
    messageThreadId: input.messageThreadId ?? existing?.messageThreadId ?? null,
    projectChannelId: input.projectChannelId ?? existing?.projectChannelId ?? null,
    language: input.language ?? existing?.language,
    status: input.status,
    pendingClarification: input.pendingClarification !== undefined
      ? input.pendingClarification
      : existing?.pendingClarification ?? null,
    orphanedArtifacts: input.orphanedArtifacts !== undefined
      ? input.orphanedArtifacts
      : existing?.orphanedArtifacts ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    suppressUntil: nextSuppressUntil(input.status),
    error: input.error ?? null,
  };
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
  if (Date.parse(session.suppressUntil) < Date.now()) return false;
  if (session.status !== "completed" && session.status !== "failed") return true;
  if (!request) return true;
  return buildBootstrapRequestFingerprint(request) === session.requestHash;
}
