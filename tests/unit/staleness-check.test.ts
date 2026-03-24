import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidBinary } from "../../lib/test-env/bootstrap.js";

describe("isValidBinary — staleness check hardening", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    tempDirs.length = 0;
  });

  it("returns false for non-existent file", async () => {
    expect(await isValidBinary("/tmp/nonexistent-binary-xyz")).toBe(false);
  });

  it("returns false for 0-byte file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-staleness-"));
    tempDirs.push(tmpDir);
    const filePath = path.join(tmpDir, "ruff");
    await fs.writeFile(filePath, "");
    await fs.chmod(filePath, 0o755);
    expect(await isValidBinary(filePath)).toBe(false);
  });

  it("returns true for non-empty file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-staleness-"));
    tempDirs.push(tmpDir);
    const filePath = path.join(tmpDir, "ruff");
    await fs.writeFile(filePath, "#!/bin/sh\necho ruff\n");
    await fs.chmod(filePath, 0o755);
    expect(await isValidBinary(filePath)).toBe(true);
  });
});

describe("toolchain fingerprint includes Python version (QA-6)", () => {
  it("fingerprint changes when Python version changes", async () => {
    const { toolchainFingerprint } = await import("../../lib/test-env/bootstrap.js");

    const mockRunCommand312 = vi.fn().mockResolvedValue({
      exitCode: 0, stdout: "Python 3.12.3\n", stderr: "",
    });
    const mockRunCommand313 = vi.fn().mockResolvedValue({
      exitCode: 0, stdout: "Python 3.13.0\n", stderr: "",
    });

    const fp312 = await toolchainFingerprint(mockRunCommand312);
    const fp313 = await toolchainFingerprint(mockRunCommand313);

    expect(fp312).not.toBe(fp313);
    expect(fp312).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });

  it("fingerprint falls back gracefully when python3 not found", async () => {
    const { toolchainFingerprint } = await import("../../lib/test-env/bootstrap.js");

    const mockRunCommandFail = vi.fn().mockResolvedValue({
      exitCode: 1, stdout: "", stderr: "python3: not found",
    });

    const fp = await toolchainFingerprint(mockRunCommandFail);
    expect(fp).toMatch(/^[a-f0-9]{64}$/); // still produces valid hash
  });
});
