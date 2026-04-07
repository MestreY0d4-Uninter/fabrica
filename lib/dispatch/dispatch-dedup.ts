/**
 * dispatch/dispatch-dedup.ts — Idempotency guard for dispatch.
 *
 * Prevents re-dispatching the same issue/role/level combo within a 5-minute window.
 * Uses a lightweight NDJSON file with TTL-based cleanup.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR } from "../setup/constants.js";

const DEDUP_FILE = "dispatch-dedup.ndjson";
const BUCKET_MS = 5 * 60_000; // 5 minutes
const DEFAULT_TTL_MS = 30 * 60_000; // 30 minutes
const ACTIVE_CLAIM_TTL_MS = 10 * 60_000; // 10 minutes safety net for in-process races

type DedupEntry = { id: string; ts: number };
const activeClaims = new Map<string, number>();

function dedupPath(workspaceDir: string): string {
  return path.join(workspaceDir, DATA_DIR, DEDUP_FILE);
}

/**
 * Compute a deterministic dispatch ID.
 * Same inputs within the same 5-minute bucket produce the same ID.
 */
export function computeDispatchId(
  projectSlug: string,
  issueId: number,
  role: string,
  level: string,
  now: number = Date.now(),
): string {
  const bucket = Math.floor(now / BUCKET_MS);
  const input = `${projectSlug}:${issueId}:${role}:${level}:${bucket}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

async function readEntries(filePath: string): Promise<DedupEntry[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((e): e is DedupEntry => e !== null && typeof e.id === "string");
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

function sweepExpiredClaims(now: number = Date.now()): void {
  for (const [dispatchId, expiresAt] of activeClaims.entries()) {
    if (expiresAt <= now) activeClaims.delete(dispatchId);
  }
}

/**
 * Check if a dispatch ID was already recorded.
 */
export async function isDuplicate(workspaceDir: string, dispatchId: string): Promise<boolean> {
  sweepExpiredClaims();
  if (activeClaims.has(dispatchId)) return true;
  const entries = await readEntries(dedupPath(workspaceDir));
  return entries.some((e) => e.id === dispatchId);
}

/**
 * Reserve a dispatch ID before the expensive async dispatch flow starts.
 * Returns true if the caller acquired the claim, false if another in-process
 * dispatcher already holds it or if it was already persisted.
 */
export async function claimDispatch(workspaceDir: string, dispatchId: string): Promise<boolean> {
  sweepExpiredClaims();
  if (activeClaims.has(dispatchId)) return false;
  const entries = await readEntries(dedupPath(workspaceDir));
  if (entries.some((e) => e.id === dispatchId)) return false;
  activeClaims.set(dispatchId, Date.now() + ACTIVE_CLAIM_TTL_MS);
  return true;
}

/**
 * Release an in-process claim when dispatch setup fails before the completed
 * dispatch is persisted.
 */
export function releaseDispatchClaim(dispatchId: string): void {
  activeClaims.delete(dispatchId);
}

/**
 * Record a completed dispatch.
 */
export async function recordDispatch(workspaceDir: string, dispatchId: string): Promise<void> {
  const filePath = dedupPath(workspaceDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const entry: DedupEntry = { id: dispatchId, ts: Date.now() };
  await fs.appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
  activeClaims.delete(dispatchId);
}

/**
 * Remove entries older than TTL.
 */
export async function cleanupExpired(workspaceDir: string, ttlMs: number = DEFAULT_TTL_MS): Promise<void> {
  const filePath = dedupPath(workspaceDir);
  const entries = await readEntries(filePath);
  const cutoff = Date.now() - ttlMs;
  const kept = entries.filter((e) => e.ts >= cutoff);
  if (kept.length < entries.length) {
    const content = kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length > 0 ? "\n" : "");
    const tmpPath = filePath + ".tmp";
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, filePath);
  }
}
