import { describe, it, expect, vi, afterEach } from "vitest";
import { writeSafe } from "../../lib/projects/io-helpers.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("writeSafe", () => {
  it("writes content to file normally", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "writeSafe-"));
    const filePath = path.join(tmpDir, "test.json");
    await writeSafe(filePath, '{"test": true}');
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe('{"test": true}');
    const files = await fs.readdir(tmpDir);
    expect(files).toEqual(["test.json"]);
    await fs.rm(tmpDir, { recursive: true });
  });

  it("falls back to copyFile on EXDEV and removes .tmp", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "writeSafe-exdev-"));
    const filePath = path.join(tmpDir, "data.json");

    const exdevErr = Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    const renameSpy = vi.spyOn(fs, "rename").mockRejectedValueOnce(exdevErr);

    await writeSafe(filePath, '{"exdev": true}');

    // Verify content was written via copyFile fallback
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe('{"exdev": true}');

    // Verify the .tmp file was cleaned up
    const files = await fs.readdir(tmpDir);
    expect(files).not.toContain("data.json.tmp");

    renameSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true });
  });

  it("cleans up .tmp and re-throws on non-EXDEV error", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "writeSafe-err-"));
    const filePath = path.join(tmpDir, "data.json");

    const diskErr = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    const renameSpy = vi.spyOn(fs, "rename").mockRejectedValueOnce(diskErr);

    await expect(writeSafe(filePath, '{"fail": true}')).rejects.toThrow("no space left on device");

    // Verify the .tmp file was cleaned up
    const files = await fs.readdir(tmpDir);
    expect(files).not.toContain("data.json.tmp");

    renameSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true });
  });
});

describe("mutation functions use withProjectsMutation", () => {
  it("activateWorker source uses withProjectsMutation", () => {
    const source = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../lib/projects/mutations.ts"),
      "utf-8",
    );
    const activateSection = source.slice(
      source.indexOf("export async function activateWorker"),
      source.indexOf("export async function deactivateWorker"),
    );
    expect(activateSection).toContain("withProjectsMutation");
    expect(activateSection).not.toContain("acquireLock");
  });

  it("deactivateWorker source uses withProjectsMutation", () => {
    const source = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../lib/projects/mutations.ts"),
      "utf-8",
    );
    const deactivateSection = source.slice(
      source.indexOf("export async function deactivateWorker"),
      source.indexOf("export async function updateIssueRuntime"),
    );
    expect(deactivateSection).toContain("withProjectsMutation");
    expect(deactivateSection).not.toContain("acquireLock");
  });

  it("updateIssueRuntime source uses withProjectsMutation", () => {
    const source = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../lib/projects/mutations.ts"),
      "utf-8",
    );
    const updateSection = source.slice(
      source.indexOf("export async function updateIssueRuntime"),
      source.indexOf("export async function clearIssueRuntime"),
    );
    expect(updateSection).toContain("withProjectsMutation");
    expect(updateSection).not.toContain("acquireLock");
  });

  it("clearIssueRuntime source uses withProjectsMutation", () => {
    const source = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../lib/projects/mutations.ts"),
      "utf-8",
    );
    const clearSection = source.slice(
      source.indexOf("export async function clearIssueRuntime"),
    );
    expect(clearSection).toContain("withProjectsMutation");
    expect(clearSection).not.toContain("acquireLock");
  });
});
