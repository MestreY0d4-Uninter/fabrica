import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { acquireLock, releaseLock, lockPath } from "../../lib/projects/io.js";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const LOCK_STALE_MS = 30_000;

describe("acquireLock with PID", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "lock-test-"));
    // Create the data directory that lockPath expects
    const dataDir = join(workspaceDir, "fabrica");
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(async () => {
    try { await releaseLock(workspaceDir); } catch { /* ignore */ }
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("stores PID in lock file as JSON", async () => {
    await acquireLock(workspaceDir);
    const lockContent = await readFile(lockPath(workspaceDir), "utf-8");
    const parsed = JSON.parse(lockContent);
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.timestamp).toBeGreaterThan(0);
    await releaseLock(workspaceDir);
  });

  it("force-unlocks when lock holder PID is dead AND lock is stale", async () => {
    const lock = lockPath(workspaceDir);
    // Write a stale lock with dead PID — timestamp older than LOCK_STALE_MS
    await writeFile(lock, JSON.stringify({
      pid: 999999,
      timestamp: Date.now() - LOCK_STALE_MS - 1000,
    }));
    // acquireLock should detect dead PID + stale timestamp and force-unlock
    await acquireLock(workspaceDir);
    await releaseLock(workspaceDir);
  });

  it("parses legacy plain-timestamp lock format as stale", async () => {
    const lock = lockPath(workspaceDir);
    // Legacy format: just a timestamp string (no JSON, no PID)
    await writeFile(lock, String(Date.now() - LOCK_STALE_MS - 1000));
    // Should treat as stale (no PID = assume dead)
    await acquireLock(workspaceDir);
    await releaseLock(workspaceDir);
  });
});
