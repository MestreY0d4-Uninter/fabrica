/**
 * Unit tests for audit logging with native rotation (Patch 2).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { log } from "../../lib/audit.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DATA_DIR } from "../../lib/setup/constants.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-audit-test-"));
  // Create the canonical Fabrica data dir structure.
  await fs.mkdir(path.join(tmpDir, DATA_DIR, "log"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("audit log", () => {
  it("creates log entry in NDJSON format", async () => {
    await log(tmpDir, "test_event", { key: "value" });
    const content = await fs.readFile(
      path.join(tmpDir, DATA_DIR, "log", "audit.log"),
      "utf-8",
    );
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.event).toBe("test_event");
    expect(entry.key).toBe("value");
    expect(entry.ts).toBeDefined();
  });

  it("appends multiple entries", async () => {
    await log(tmpDir, "event1", { a: 1 });
    await log(tmpDir, "event2", { b: 2 });
    await log(tmpDir, "event3", { c: 3 });

    const content = await fs.readFile(
      path.join(tmpDir, DATA_DIR, "log", "audit.log"),
      "utf-8",
    );
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(3);

    expect(JSON.parse(lines[0]).event).toBe("event1");
    expect(JSON.parse(lines[1]).event).toBe("event2");
    expect(JSON.parse(lines[2]).event).toBe("event3");
  });

  it("creates directory if it does not exist", async () => {
    const freshDir = path.join(tmpDir, "fresh-workspace");
    await log(freshDir, "auto_create", { test: true });
    const content = await fs.readFile(
      path.join(freshDir, DATA_DIR, "log", "audit.log"),
      "utf-8",
    );
    expect(content).toContain("auto_create");
  });

  it("never throws on logging errors", async () => {
    // Log to a read-only path should not throw
    await expect(log("/dev/null/impossible", "bad", {})).resolves.toBeUndefined();
  });
});
