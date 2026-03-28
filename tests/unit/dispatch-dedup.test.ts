import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DATA_DIR } from "../../lib/setup/constants.js";
import {
  computeDispatchId,
  isDuplicate,
  recordDispatch,
  cleanupExpired,
} from "../../lib/dispatch/dispatch-dedup.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-dedup-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("computeDispatchId", () => {
  it("produces deterministic ID for same inputs in same 5-min bucket", () => {
    const ts1 = new Date("2026-03-17T10:01:00Z").getTime();
    const ts2 = new Date("2026-03-17T10:03:00Z").getTime();
    const id1 = computeDispatchId("proj", 1, "developer", "junior", ts1);
    const id2 = computeDispatchId("proj", 1, "developer", "junior", ts2);
    expect(id1).toBe(id2); // same 5-min bucket
  });

  it("produces different ID across 5-min bucket boundaries", () => {
    const ts1 = new Date("2026-03-17T10:04:00Z").getTime();
    const ts2 = new Date("2026-03-17T10:06:00Z").getTime();
    const id1 = computeDispatchId("proj", 1, "developer", "junior", ts1);
    const id2 = computeDispatchId("proj", 1, "developer", "junior", ts2);
    expect(id1).not.toBe(id2); // different 5-min buckets
  });
});

describe("isDuplicate + recordDispatch", () => {
  it("returns false for first dispatch", async () => {
    expect(await isDuplicate(tmpDir, "abc123")).toBe(false);
  });

  it("returns true after dispatch is recorded", async () => {
    await recordDispatch(tmpDir, "abc123");
    expect(await isDuplicate(tmpDir, "abc123")).toBe(true);
  });

  it("returns false for different dispatchId", async () => {
    await recordDispatch(tmpDir, "abc123");
    expect(await isDuplicate(tmpDir, "xyz789")).toBe(false);
  });
});

describe("cleanupExpired", () => {
  it("removes entries older than TTL", async () => {
    // Write an old entry manually
    const dedupPath = path.join(tmpDir, DATA_DIR, "dispatch-dedup.ndjson");
    await fs.mkdir(path.dirname(dedupPath), { recursive: true });
    const oldEntry = JSON.stringify({ id: "old", ts: Date.now() - 3600_000 }) + "\n";
    const newEntry = JSON.stringify({ id: "new", ts: Date.now() }) + "\n";
    await fs.writeFile(dedupPath, oldEntry + newEntry, "utf-8");

    await cleanupExpired(tmpDir, 1800_000); // 30 min TTL

    expect(await isDuplicate(tmpDir, "old")).toBe(false);
    expect(await isDuplicate(tmpDir, "new")).toBe(true);
  });
});
