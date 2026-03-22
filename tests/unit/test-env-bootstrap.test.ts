import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureProjectTestEnvironment,
  ensurePythonToolchain,
  ensureUv,
  getQaGateCommands,
  getSupportedGreenfieldStacks,
  supportsGreenfieldScaffold,
  PYTHON_TOOLCHAIN_PACKAGES,
} from "../../lib/test-env/bootstrap.js";

const tempDirs: string[] = [];

async function makeTempRepo(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("test-env bootstrap", () => {
  it("flags only implemented greenfield scaffold stacks as supported", () => {
    expect(getSupportedGreenfieldStacks()).toEqual([
      "nextjs",
      "node-cli",
      "express",
      "fastapi",
      "flask",
      "django",
      "python-cli",
    ]);
    expect(supportsGreenfieldScaffold("python-cli")).toBe(true);
    expect(supportsGreenfieldScaffold("go")).toBe(false);
    expect(supportsGreenfieldScaffold("java")).toBe(false);
  });

  it("fails closed for existing Node repos without a lockfile", async () => {
    const repoPath = await makeTempRepo("fabrica-node-no-lock-");
    await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({
      name: "no-lock",
      private: true,
      scripts: { test: "echo ok" },
    }, null, 2));

    const result = await ensureProjectTestEnvironment({
      repoPath,
      stack: "node-cli",
      mode: "qa",
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toBe("missing_lockfile_for_reproducible_test_bootstrap");
  });

  it("allows a greenfield Node scaffold to create a deterministic lockfile once", async () => {
    const repoPath = await makeTempRepo("fabrica-node-greenfield-");
    await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({
      name: "greenfield-node",
      private: true,
      scripts: { test: "echo ok" },
    }, null, 2));

    const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const result = await ensureProjectTestEnvironment({
      repoPath,
      stack: "node-cli",
      mode: "scaffold",
      runCommand: async (cmd, args, opts) => {
        calls.push({ cmd, args, cwd: opts?.cwd });
        if (cmd === "npm" && args[0] === "--version") {
          return { stdout: "10.0.0\n", stderr: "", exitCode: 0 };
        }
        if (cmd === "npm" && args[0] === "install") {
          await fs.mkdir(path.join(repoPath, "node_modules"), { recursive: true });
          await fs.writeFile(path.join(repoPath, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }), "utf-8");
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(result.ready).toBe(true);
    expect(result.packageManager).toBe("npm");
    expect(result.lockfile).toBe("package-lock.json");
    expect(calls.some((call) => call.cmd === "npm" && call.args[0] === "install")).toBe(true);
  });

  it("auto-installs uv and uses it for project venv when uv is initially missing", async () => {
    const repoPath = await makeTempRepo("fabrica-python-bootstrap-");
    await fs.writeFile(path.join(repoPath, "pyproject.toml"), `
[project]
name = "password-cli"
version = "0.1.0"
[project.optional-dependencies]
dev = ["pytest>=8.0.0"]
`, "utf-8");

    const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    let uvInstalled = false;
    const result = await ensureProjectTestEnvironment({
      repoPath,
      stack: "python-cli",
      mode: "scaffold",
      runCommand: async (cmd, args, opts) => {
        calls.push({ cmd, args, cwd: opts?.cwd });
        // First uv --version check fails (uv not installed yet)
        if (cmd === "uv" && args[0] === "--version" && !uvInstalled) {
          return { stdout: "", stderr: "missing", exitCode: 127 };
        }
        // Install script succeeds
        if (cmd === "bash" && args[1]?.includes("astral.sh")) {
          uvInstalled = true;
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        // Second uv --version check succeeds (after install)
        if (cmd === "uv" && args[0] === "--version" && uvInstalled) {
          return { stdout: "uv 0.6.0\n", stderr: "", exitCode: 0 };
        }
        if (cmd === "uv" && args[0] === "venv") {
          const target = args[1] === ".venv" ? path.join(repoPath, ".venv") : args[1];
          await fs.mkdir(path.join(target, "bin"), { recursive: true });
          await fs.writeFile(path.join(target, "bin", "python"), "", "utf-8");
          await fs.writeFile(path.join(target, "bin", "ruff"), "", { mode: 0o755 });
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(result.ready).toBe(true);
    expect(result.packageManager).toBe("uv");
    expect(calls.some((c) => c.cmd === "bash" && c.args[1]?.includes("astral.sh"))).toBe(true);
    expect(calls.some((c) => c.cmd === "uv" && c.args[0] === "venv")).toBe(true);
  });

  it("prefers uv for project-local Python bootstrap when available", async () => {
    const repoPath = await makeTempRepo("fabrica-python-uv-bootstrap-");
    await fs.writeFile(path.join(repoPath, "pyproject.toml"), `
[project]
name = "password-cli"
version = "0.1.0"
[project.optional-dependencies]
dev = ["pytest>=8.0.0"]
`, "utf-8");

    const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const result = await ensureProjectTestEnvironment({
      repoPath,
      stack: "python-cli",
      mode: "scaffold",
      runCommand: async (cmd, args, opts) => {
        calls.push({ cmd, args, cwd: opts?.cwd });
        if (cmd === "uv" && args[0] === "--version") {
          return { stdout: "uv 0.6.0\n", stderr: "", exitCode: 0 };
        }
        if (cmd === "uv" && args.join(" ") === "venv .venv") {
          await fs.mkdir(path.join(repoPath, ".venv", "bin"), { recursive: true });
          await fs.writeFile(path.join(repoPath, ".venv", "bin", "python"), "", "utf-8");
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (cmd === "uv" && args.join(" ") === "pip install --python .venv/bin/python -e .[dev]") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(result.ready).toBe(true);
    expect(result.packageManager).toBe("uv");
    expect(calls.some((call) => call.cmd === "uv" && call.args.join(" ") === "venv .venv")).toBe(true);
    expect(calls.some((call) => call.cmd === "uv" && call.args.join(" ") === "pip install --python .venv/bin/python -e .[dev]")).toBe(true);
  });

  it("uses uv sync --locked when uv.lock exists", async () => {
    const repoPath = await makeTempRepo("fabrica-uv-lock-");
    await fs.writeFile(path.join(repoPath, "uv.lock"), "version = 1\n", "utf-8");
    await fs.writeFile(path.join(repoPath, "pyproject.toml"), "[project]\nname='x'\nversion='0.1.0'\n", "utf-8");

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const result = await ensureProjectTestEnvironment({
      repoPath,
      stack: "python-cli",
      mode: "qa",
      runCommand: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "uv" && args[0] === "--version") {
          return { stdout: "uv 0.6.0\n", stderr: "", exitCode: 0 };
        }
        if (cmd === "uv" && args[0] === "venv") {
          await fs.mkdir(path.join(repoPath, ".venv", "bin"), { recursive: true });
          await fs.writeFile(path.join(repoPath, ".venv", "bin", "python"), "", "utf-8");
          await fs.writeFile(path.join(repoPath, ".venv", "bin", "ruff"), "", { mode: 0o755 });
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(result.ready).toBe(true);
    expect(calls.some((c) => c.cmd === "uv" && c.args.join(" ").includes("sync --locked"))).toBe(true);
  });

});

describe("getQaGateCommands", () => {
  it("returns stack-aware Node gate commands", () => {
    expect(getQaGateCommands("nextjs").lint).toBe("next lint");
    expect(getQaGateCommands("node-cli").lint).toBe("npm run lint");
  });
});

describe("ensureUv", () => {
  it("returns uv path when uv is already available", async () => {
    const runCommand = async (cmd: string, args: string[]) => {
      if (cmd === "uv" && args[0] === "--version") {
        return { stdout: "uv 0.6.0\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const result = await ensureUv(runCommand);
    expect(result).toBe("uv");
  });

  it("installs uv when not found and returns path", async () => {
    const commandsRun: string[] = [];
    let installed = false;
    const runCommand = async (cmd: string, args: string[]) => {
      commandsRun.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "uv" && args[0] === "--version" && !installed) {
        return { stdout: "", stderr: "missing", exitCode: 127 };
      }
      if (cmd === "bash") {
        installed = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd === "uv" && args[0] === "--version" && installed) {
        return { stdout: "uv 0.6.0\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const result = await ensureUv(runCommand);
    expect(result).toBe("uv");
    expect(commandsRun.some(c => c.includes("astral.sh/uv/install.sh"))).toBe(true);
  });

  it("throws when uv install fails", async () => {
    const runCommand = async (cmd: string, args: string[]) => {
      if (cmd === "uv") return { stdout: "", stderr: "missing", exitCode: 127 };
      return { stdout: "", stderr: "network error", exitCode: 1 };
    };
    await expect(ensureUv(runCommand)).rejects.toThrow(/uv/i);
  });
});

describe("ensurePythonToolchain", () => {
  it("creates toolchain venv and installs tools when missing", async () => {
    const tmpHome = await makeTempRepo("fabrica-toolchain-");
    const toolchainPath = path.join(tmpHome, ".openclaw", "toolchains", "python");
    const commandsRun: string[] = [];

    const runCommand = async (cmd: string, args: string[]) => {
      commandsRun.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "uv" && args[0] === "venv") {
        await fs.mkdir(path.join(args[1], "bin"), { recursive: true });
        await fs.writeFile(path.join(args[1], "bin", "ruff"), "#!/bin/sh\n", { mode: 0o755 });
        await fs.writeFile(path.join(args[1], "bin", "mypy"), "#!/bin/sh\n", { mode: 0o755 });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const result = await ensurePythonToolchain(runCommand, tmpHome);
    expect(result).toBe(toolchainPath);
    expect(commandsRun.some(c => c.includes("uv venv"))).toBe(true);
    expect(commandsRun.some(c => c.includes("ruff") && c.includes("mypy") && c.includes("pip-audit"))).toBe(true);
  });

  it("skips creation when toolchain exists with matching fingerprint", async () => {
    const tmpHome = await makeTempRepo("fabrica-toolchain-cached-");
    const toolchainPath = path.join(tmpHome, ".openclaw", "toolchains", "python");
    await fs.mkdir(path.join(toolchainPath, "bin"), { recursive: true });
    await fs.writeFile(path.join(toolchainPath, "bin", "ruff"), "#!/bin/sh\n", { mode: 0o755 });

    // Write matching fingerprint
    const hash = createHash("sha256").update(PYTHON_TOOLCHAIN_PACKAGES.join(",")).digest("hex");
    await fs.writeFile(path.join(toolchainPath, "toolchain.sha256"), hash);

    const commandsRun: string[] = [];
    const runCommand = async (cmd: string, args: string[]) => {
      commandsRun.push(`${cmd} ${args.join(" ")}`);
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const result = await ensurePythonToolchain(runCommand, tmpHome);
    expect(result).toBe(toolchainPath);
    // No uv commands should have been run
    expect(commandsRun.filter(c => c.startsWith("uv"))).toHaveLength(0);
  });

  it("rebuilds when fingerprint mismatches", async () => {
    const tmpHome = await makeTempRepo("fabrica-toolchain-stale-");
    const toolchainPath = path.join(tmpHome, ".openclaw", "toolchains", "python");
    await fs.mkdir(path.join(toolchainPath, "bin"), { recursive: true });
    await fs.writeFile(path.join(toolchainPath, "bin", "ruff"), "#!/bin/sh\n", { mode: 0o755 });
    await fs.writeFile(path.join(toolchainPath, "toolchain.sha256"), "old-hash");

    const commandsRun: string[] = [];
    const runCommand = async (cmd: string, args: string[]) => {
      commandsRun.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "uv" && args[0] === "venv") {
        await fs.mkdir(path.join(args[1], "bin"), { recursive: true });
        await fs.writeFile(path.join(args[1], "bin", "ruff"), "#!/bin/sh\n", { mode: 0o755 });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const result = await ensurePythonToolchain(runCommand, tmpHome);
    expect(result).toBe(toolchainPath);
    expect(commandsRun.some(c => c.includes("uv venv"))).toBe(true);
  });
});

describe("ensurePythonEnvironment integration", () => {
  it("calls ensureUv before creating venv when uv is not available", async () => {
    const repoPath = await makeTempRepo("fabrica-python-env-");
    await fs.writeFile(path.join(repoPath, "pyproject.toml"), `[project]\nname = "test"\nversion = "0.1.0"\n`);

    const commandsRun: string[] = [];
    let uvInstalled = false;
    const runCommand = async (cmd: string, args: string[], opts?: any) => {
      commandsRun.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "uv" && args[0] === "--version" && !uvInstalled) {
        return { stdout: "", stderr: "missing", exitCode: 127 };
      }
      if (cmd === "bash" && args[1]?.includes("astral.sh")) {
        uvInstalled = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd === "uv" && args[0] === "--version" && uvInstalled) {
        return { stdout: "uv 0.6.0\n", stderr: "", exitCode: 0 };
      }
      if (cmd === "uv") {
        if (args[0] === "venv") {
          const target = args[1] === ".venv" ? path.join(repoPath, ".venv") : args[1];
          await fs.mkdir(path.join(target, "bin"), { recursive: true });
          await fs.writeFile(path.join(target, "bin", "python"), "#!/bin/sh\n", { mode: 0o755 });
          await fs.writeFile(path.join(target, "bin", "ruff"), "#!/bin/sh\n", { mode: 0o755 });
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "uv 0.6.0", stderr: "", exitCode: 0 };
    };

    const result = await ensureProjectTestEnvironment({
      repoPath,
      stack: "python-cli",
      mode: "scaffold",
      runCommand,
    });

    expect(result.ready).toBe(true);
    // ensureUv (--version check) should be called before venv creation
    const versionIdx = commandsRun.findIndex(c => c.includes("uv --version"));
    const venvIdx = commandsRun.findIndex(c => c.includes("uv venv .venv"));
    expect(versionIdx).toBeLessThan(venvIdx);
  });
});
