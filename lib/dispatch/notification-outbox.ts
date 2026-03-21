/**
 * dispatch/notification-outbox.ts — Idempotent notification outbox.
 *
 * Flow: write intent → send → mark delivered.
 * Prevents duplicate sends on crash/restart.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR } from "../setup/migrate-layout.js";

const OUTBOX_FILE = "notifications-outbox.ndjson";
const DEFAULT_TTL_MS = 60 * 60_000; // 1 hour

type OutboxEntry = {
  key: string;
  ts: number;
  status: "pending" | "delivered";
  data: Record<string, unknown>;
  deliveryTarget?: {
    channelId: string;
    channel?: string;
    accountId?: string;
    messageThreadId?: number;
  };
};

function outboxPath(workspaceDir: string): string {
  return path.join(workspaceDir, DATA_DIR, OUTBOX_FILE);
}

async function readEntries(filePath: string): Promise<OutboxEntry[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((e): e is OutboxEntry => e !== null && typeof e.key === "string");
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeEntries(filePath: string, entries: OutboxEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : ""),
    "utf-8",
  );
}

/**
 * Compute deterministic notification key.
 */
export function computeNotifyKey(
  projectSlug: string,
  issueId: number,
  eventType: string,
  roundedTs?: number,
): string {
  const ts = roundedTs ?? Math.floor(Date.now() / 60_000); // 1-min bucket
  const input = `${projectSlug}:${issueId}:${eventType}:${ts}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Write a notification intent. No-op if key already exists.
 * Returns true if the intent was written (new), false if it already existed (duplicate).
 */
export async function writeIntent(
  workspaceDir: string,
  key: string,
  data: Record<string, unknown>,
  deliveryTarget?: OutboxEntry["deliveryTarget"],
): Promise<boolean> {
  const filePath = outboxPath(workspaceDir);
  const entries = await readEntries(filePath);
  if (entries.some((e) => e.key === key)) return false; // dedup

  entries.push({ key, ts: Date.now(), status: "pending", data, deliveryTarget });
  await writeEntries(filePath, entries);
  return true;
}

/**
 * Mark a notification as delivered.
 */
export async function markDelivered(workspaceDir: string, key: string): Promise<void> {
  const filePath = outboxPath(workspaceDir);
  const entries = await readEntries(filePath);
  const updated = entries.map((e) =>
    e.key === key ? { ...e, status: "delivered" as const } : e,
  );
  await writeEntries(filePath, updated);
}

/**
 * Get all pending intents (for reprocessing on startup or stale-recovery).
 */
export async function getPendingIntents(workspaceDir: string): Promise<OutboxEntry[]> {
  const entries = await readEntries(outboxPath(workspaceDir));
  return entries.filter((e) => e.status === "pending");
}

/**
 * Remove entries older than TTL.
 */
export async function cleanupOld(
  workspaceDir: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<void> {
  const filePath = outboxPath(workspaceDir);
  const entries = await readEntries(filePath);
  const cutoff = Date.now() - ttlMs;
  const kept = entries.filter((e) => e.ts >= cutoff);
  if (kept.length < entries.length) {
    await writeEntries(filePath, kept);
  }
}
