import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { backupFile, writeSafe, readJsonWithFallback } from "../../lib/projects/io-helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("backupFile", () => {
  it("copies current file to .bak before write", async () => {
    const filePath = path.join(tmpDir, "data.json");
    await fs.writeFile(filePath, '{"version":1}', "utf-8");
    await backupFile(filePath);
    const bak = await fs.readFile(filePath + ".bak", "utf-8");
    expect(bak).toBe('{"version":1}');
  });

  it("no-ops when file does not exist yet", async () => {
    const filePath = path.join(tmpDir, "missing.json");
    await expect(backupFile(filePath)).resolves.toBeUndefined();
  });
});

describe("writeSafe", () => {
  it("writes atomically via temp + datasync + rename", async () => {
    const filePath = path.join(tmpDir, "out.json");
    await writeSafe(filePath, '{"ok":true}\n');
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe('{"ok":true}\n');
    await expect(fs.access(filePath + ".tmp")).rejects.toThrow();
  });
});

describe("readJsonWithFallback", () => {
  it("reads main file when valid JSON", async () => {
    const filePath = path.join(tmpDir, "data.json");
    await fs.writeFile(filePath, '{"v":1}', "utf-8");
    const result = await readJsonWithFallback(filePath);
    expect(result).toBe('{"v":1}');
  });

  it("falls back to .bak when main file has corrupt JSON", async () => {
    const filePath = path.join(tmpDir, "data.json");
    await fs.writeFile(filePath, "CORRUPT{{{", "utf-8");
    await fs.writeFile(filePath + ".bak", '{"v":2}', "utf-8");
    const result = await readJsonWithFallback(filePath);
    expect(result).toBe('{"v":2}');
  });

  it("throws when both main and .bak are corrupt", async () => {
    const filePath = path.join(tmpDir, "data.json");
    await fs.writeFile(filePath, "BAD", "utf-8");
    await fs.writeFile(filePath + ".bak", "ALSO BAD", "utf-8");
    await expect(readJsonWithFallback(filePath)).rejects.toThrow();
  });

  it("throws when main is corrupt and .bak does not exist", async () => {
    const filePath = path.join(tmpDir, "data.json");
    await fs.writeFile(filePath, "BAD", "utf-8");
    await expect(readJsonWithFallback(filePath)).rejects.toThrow();
  });
});
