/**
 * genesis-health.ts — Health monitoring for the genesis agent's bootstrap sessions.
 *
 * Genesis has no heartbeat of its own. If it stops processing DMs, sessions
 * get stuck in intermediate states. This module detects such stale sessions.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getRootLogger } from "../../observability/logger.js";
import { DATA_DIR } from "../../setup/constants.js";

const STALE_THRESHOLD_MS = 5 * 60_000; // 5 minutes
const STALE_STATUSES = new Set(["pending_classify", "classifying"]);

export interface BootstrapSessionSummary {
  id: string;
  status: string;
  updatedAt: number;
}

/**
 * Detect bootstrap sessions stuck in intermediate states.
 * Returns sessions where status is pending_classify/classifying AND age > 5 minutes.
 */
export function detectStaleBootstrapSessions(
  sessions: BootstrapSessionSummary[],
): BootstrapSessionSummary[] {
  const now = Date.now();
  return sessions.filter(
    (s) => STALE_STATUSES.has(s.status) && now - s.updatedAt > STALE_THRESHOLD_MS,
  );
}

/**
 * Read all bootstrap sessions from the workspace and check for stale ones.
 * Logs a warning if any stale sessions are found.
 */
export async function checkGenesisHealth(workspaceDir: string): Promise<void> {
  const logger = getRootLogger().child({ pass: "genesis-health" });
  const sessionsDir = path.join(workspaceDir, DATA_DIR, "bootstrap-sessions");

  let files: string[];
  try {
    files = await fs.readdir(sessionsDir);
  } catch {
    return; // directory doesn't exist — genesis not yet active
  }

  const sessions: BootstrapSessionSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(sessionsDir, file), "utf-8");
      const data = JSON.parse(raw) as { status?: string; updatedAt?: string | number; conversationId?: string };
      const id = data.conversationId ?? file.replace(/\.json$/, "");
      const updatedAt =
        typeof data.updatedAt === "string"
          ? new Date(data.updatedAt).getTime()
          : Number(data.updatedAt ?? 0);
      if (data.status && updatedAt) {
        sessions.push({ id, status: data.status, updatedAt });
      }
    } catch { /* skip malformed files */ }
  }

  const stale = detectStaleBootstrapSessions(sessions);
  if (stale.length > 0) {
    logger.warn(
      { staleCount: stale.length, sessions: stale.map((s) => s.id) },
      "[fabrica] genesis-stale-sessions: bootstrap sessions stuck — genesis agent may have stopped processing",
    );
  }
}
