import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DATA_DIR } from "../../lib/setup/constants.js";
import {
  computeNotifyKey,
  writeIntent,
  markDelivered,
  getPendingIntents,
  cleanupOld,
} from "../../lib/dispatch/notification-outbox.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-outbox-"));
  await fs.mkdir(path.join(tmpDir, DATA_DIR), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("computeNotifyKey", () => {
  it("produces deterministic key for same inputs", () => {
    const k1 = computeNotifyKey("proj", 1, "workerStart", {
      dispatchCycleId: "cycle-a",
      dispatchRunId: "run-a",
    });
    const k2 = computeNotifyKey("proj", 1, "workerStart", {
      dispatchCycleId: "cycle-a",
      dispatchRunId: "run-a",
    });
    expect(k1).toBe(k2);
  });

  it("produces different key for different event type", () => {
    const k1 = computeNotifyKey("proj", 1, "workerStart", {
      dispatchCycleId: "cycle-a",
      dispatchRunId: "run-a",
    });
    const k2 = computeNotifyKey("proj", 1, "workerComplete", {
      dispatchCycleId: "cycle-a",
      dispatchRunId: "run-a",
    });
    expect(k1).not.toBe(k2);
  });

  it("allows the same event type across different dispatch cycles", () => {
    const first = computeNotifyKey("todo-summary", 1, "workerComplete", {
      dispatchCycleId: "cycle-a",
      dispatchRunId: "run-a",
      result: "DONE",
    });
    const second = computeNotifyKey("todo-summary", 1, "workerComplete", {
      dispatchCycleId: "cycle-b",
      dispatchRunId: "run-b",
      result: "DONE",
    });

    expect(first).not.toBe(second);
  });
});

describe("outbox lifecycle", () => {
  it("writes intent and marks delivered", async () => {
    const key = "test-key-1";
    await writeIntent(tmpDir, key, { type: "workerStart" });

    const pending = await getPendingIntents(tmpDir);
    expect(pending).toHaveLength(1);
    expect(pending[0].key).toBe(key);
    expect(pending[0].status).toBe("pending");

    await markDelivered(tmpDir, key);
    const afterDeliver = await getPendingIntents(tmpDir);
    expect(afterDeliver).toHaveLength(0);
  });

  it("skips duplicate intent (same key)", async () => {
    await writeIntent(tmpDir, "dup-key", { type: "workerStart" });
    await writeIntent(tmpDir, "dup-key", { type: "workerStart" });

    const pending = await getPendingIntents(tmpDir);
    expect(pending).toHaveLength(1);
  });
});

describe("cleanupOld", () => {
  it("removes entries older than TTL", async () => {
    // Manually write an old entry
    const outboxPath = path.join(tmpDir, DATA_DIR, "notifications-outbox.ndjson");
    const old = JSON.stringify({ key: "old", ts: Date.now() - 7200_000, status: "delivered", data: {} }) + "\n";
    const fresh = JSON.stringify({ key: "new", ts: Date.now(), status: "delivered", data: {} }) + "\n";
    await fs.writeFile(outboxPath, old + fresh, "utf-8");

    await cleanupOld(tmpDir, 3600_000); // 1h TTL

    const content = await fs.readFile(outboxPath, "utf-8");
    const entries = content.trim().split("\n").filter(Boolean);
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]).key).toBe("new");
  });
});
