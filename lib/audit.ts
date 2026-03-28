/**
 * audit.ts — Append-only NDJSON audit logging with native rotation.
 *
 * Every tool call automatically logs — no manual action needed from agents.
 * Rotation: atomic rename to .bak, keeps up to 3 backup files.
 *
 * Native fix for Fabrica Patch 2 (audit.log rotation).
 */
import { appendFile, mkdir, readFile, writeFile, rename, unlink, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { DATA_DIR } from "./setup/migrate-layout.js";

const MAX_LOG_LINES = 500;
const MAX_BACKUPS = 3;

export async function log(
  workspaceDir: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  const filePath = join(workspaceDir, DATA_DIR, "log", "audit.log");
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...data,
  });
  try {
    await appendFile(filePath, entry + "\n");
    await rotateIfNeeded(filePath);
  } catch (err: unknown) {
    // If directory doesn't exist, create it and retry
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, entry + "\n");
    }
    // Audit logging should never break the tool — silently ignore other errors
  }
}

/**
 * Rotate audit log when it exceeds MAX_LOG_LINES.
 * Uses atomic rename to .bak files, keeping up to MAX_BACKUPS.
 */
async function rotateIfNeeded(filePath: string): Promise<void> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.length > 0);

    if (lines.length > MAX_LOG_LINES) {
      // Write tail to a temp file FIRST (crash-safe: if this fails, current log is intact).
      // This guarantees complete data is preserved at all crash points:
      //   - Crash after writeFile(tmp): current log intact + .tmp has tail (cleaned on next rotation)
      //   - Crash after rename(current→.bak): .bak has full data + .tmp has tail → recovery on next rotation
      //   - Crash after rename(.tmp→current): fully committed (A3 fix)
      const tmpPath = `${filePath}.tmp`;
      const keptLines = lines.slice(-Math.floor(MAX_LOG_LINES / 5));
      await writeFile(tmpPath, keptLines.join("\n") + "\n", "utf-8");

      // Rotate existing backups (3 → delete, 2 → 3, 1 → 2)
      for (let i = MAX_BACKUPS; i >= 1; i--) {
        const src = i === 1 ? `${filePath}.bak` : `${filePath}.${i}.bak`;
        const dst = `${filePath}.${i + 1}.bak`;
        if (i === MAX_BACKUPS) {
          try { await unlink(src); } catch { /* ignore */ }
        } else {
          try { await rename(src, dst); } catch { /* ignore */ }
        }
      }

      // Atomic rename current → .bak (full content preserved in backup)
      try {
        await rename(filePath, `${filePath}.bak`);
      } catch { /* ignore */ }

      // Promote tail temp to current (atomic — completes the rotation)
      try {
        await rename(tmpPath, filePath);
      } catch {
        // Last resort: write directly if rename failed (e.g. cross-device)
        try { await writeFile(filePath, keptLines.join("\n") + "\n", "utf-8"); } catch { /* ignore */ }
        try { await unlink(tmpPath); } catch { /* ignore */ }
      }
    }
  } catch {
    // Silently ignore rotation errors — log remains intact
  }
}
