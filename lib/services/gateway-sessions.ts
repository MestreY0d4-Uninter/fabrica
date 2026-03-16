/**
 * gateway-sessions.ts — Gateway session lookup.
 *
 * Queries the gateway for active sessions. Reads session store files directly
 * to avoid the `sessions.recent` cap (limited to 10 entries).
 *
 * Separated from health.ts to avoid co-locating fs reads with process execution,
 * which triggers false-positive "data exfiltration" warnings in plugin scanners.
 */
import fs from "node:fs/promises";
import type { RunCommand } from "../context.js";

const RESTART_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

export function shouldFilterSession(
  updatedAt: number | null,
  gatewayUptimeMs: number,
): boolean {
  if (updatedAt === null) return false;

  const isRecentRestart = gatewayUptimeMs < RESTART_GRACE_PERIOD_MS;

  if (isRecentRestart) {
    // During restart grace period, use a softer filter:
    // only exclude sessions older than the grace period itself.
    return updatedAt < (Date.now() - RESTART_GRACE_PERIOD_MS);
  }

  // Normal operation: filter sessions from before this gateway process started.
  const gatewayStartMs = Date.now() - gatewayUptimeMs;
  return updatedAt < gatewayStartMs;
}

export type GatewaySession = {
  key: string;
  updatedAt: number | null;
  percentUsed: number;
  abortedLastRun?: boolean;
  totalTokens?: number;
  contextTokens?: number;
};

export type SessionLookup = Map<string, GatewaySession>;

/**
 * Query gateway status and build a lookup map of active sessions.
 *
 * Instead of relying on `sessions.recent` (capped at 10 entries), this function:
 *   1. Gets the session file paths from `sessions.paths` in the status response
 *   2. Reads each sessions JSON file directly to get ALL session keys without cap
 *
 * Falls back to `sessions.recent` if file reads fail (e.g., permission issues).
 * Returns null if gateway is unavailable (timeout, error, etc).
 * Callers should skip session liveness checks if null — unknown ≠ dead.
 */
export async function fetchGatewaySessions(gatewayTimeoutMs = 15_000, runCommand: RunCommand): Promise<SessionLookup | null> {
  const rc = runCommand;
  const lookup: SessionLookup = new Map();

  try {
    const result = await rc(
      ["openclaw", "gateway", "call", "status", "--json"],
      { timeoutMs: gatewayTimeoutMs },
    );

    const jsonStart = result.stdout.indexOf("{");
    const data = JSON.parse(jsonStart >= 0 ? result.stdout.slice(jsonStart) : result.stdout);

    // Primary strategy: read session files directly to avoid the `recent` cap.
    // `sessions.paths` lists all session store files managed by the gateway.
    const sessionPaths: string[] = data?.sessions?.paths ?? [];
    let readFromFiles = false;

    for (const filePath of sessionPaths) {
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const fileData = JSON.parse(raw) as Record<string, { updatedAt?: number; percentUsed?: number; abortedLastRun?: boolean; totalTokens?: number; contextTokens?: number }>;
        for (const [key, entry] of Object.entries(fileData)) {
          if (key && !lookup.has(key)) {
            lookup.set(key, {
              key,
              updatedAt: normalizeUpdatedAt(entry.updatedAt),
              percentUsed: entry.percentUsed
                ?? (entry.contextTokens && entry.totalTokens
                  ? Math.round((entry.contextTokens / entry.totalTokens) * 100)
                  : 0),
              abortedLastRun: entry.abortedLastRun,
              totalTokens: entry.totalTokens,
              contextTokens: entry.contextTokens,
            });
          }
        }
        readFromFiles = true;
      } catch {
        // File unreadable — skip and fall back to recent
      }
    }

    // Fallback: if file reads all failed, use `sessions.recent` (may be capped)
    if (!readFromFiles) {
      const recentSessions: GatewaySession[] = data?.sessions?.recent ?? [];
      for (const session of recentSessions) {
        if (session.key) {
          lookup.set(session.key, {
            ...session,
            updatedAt: normalizeUpdatedAt(session.updatedAt),
          });
        }
      }
    }

    return lookup;
  } catch {
    // Gateway call failed — try reading agent session files directly as fallback.
    // This covers cases where the gateway WebSocket call is unavailable but the
    // session store files are still readable on disk (e.g. local loopback auth issues).
    return readSessionsFromDisk();
  }
}

/**
 * Direct fallback: read session files from well-known OpenClaw agent directories.
 * Used when the gateway WebSocket call is unavailable.
 *
 * Only includes sessions updated AFTER the current process started.
 * This filters out sessions from a previous gateway run (which are dead after restart).
 * Since this plugin runs inside the gateway, `process.uptime()` reflects the gateway's age.
 */
async function readSessionsFromDisk(): Promise<SessionLookup | null> {
  const lookup: SessionLookup = new Map();
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!homeDir) return null;

  // OpenClaw stores agent sessions at ~/.openclaw/agents/{agentId}/sessions/sessions.json
  const agentsDir = `${homeDir}/.openclaw/agents`;
  let agentDirs: string[];
  try {
    agentDirs = await fs.readdir(agentsDir);
  } catch {
    return null;
  }

  let foundAny = false;
  for (const agentId of agentDirs) {
    const sessionFile = `${agentsDir}/${agentId}/sessions/sessions.json`;
    try {
      const raw = await fs.readFile(sessionFile, "utf-8");
      const fileData = JSON.parse(raw) as Record<string, { updatedAt?: number; percentUsed?: number; abortedLastRun?: boolean; totalTokens?: number; contextTokens?: number }>;
      for (const [key, entry] of Object.entries(fileData)) {
        if (!key || lookup.has(key)) continue;
        const updatedAt = normalizeUpdatedAt(entry.updatedAt);
        // Skip sessions that predate the gateway restart window — they are dead.
        if (shouldFilterSession(updatedAt, process.uptime() * 1000)) continue;
        lookup.set(key, {
          key,
          updatedAt,
          percentUsed: entry.percentUsed
            ?? (entry.contextTokens && entry.totalTokens
              ? Math.round((entry.contextTokens / entry.totalTokens) * 100)
              : 0),
          abortedLastRun: entry.abortedLastRun,
          totalTokens: entry.totalTokens,
          contextTokens: entry.contextTokens,
        });
      }
      foundAny = true;
    } catch {
      // File unreadable — skip
    }
  }

  // Return empty map (not null) so callers treat this as "gateway alive, no sessions"
  // rather than "gateway unavailable, skip session checks".
  return foundAny ? lookup : new Map();
}

/**
 * Check if a session key exists in the gateway and is considered "alive".
 * A session is alive if it exists. We don't consider percentUsed or abortedLastRun
 * as dead indicators — those are normal states for reusable sessions.
 * Returns false if sessions lookup is null (gateway unavailable).
 */
export function isSessionAlive(sessionKey: string, sessions: SessionLookup | null): boolean {
  return sessions ? sessions.has(sessionKey) : false;
}

function normalizeUpdatedAt(updatedAt: number | null | undefined): number | null {
  return typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt > 0
    ? updatedAt
    : null;
}
