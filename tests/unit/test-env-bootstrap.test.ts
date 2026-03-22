import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureProjectTestEnvironment,
  ensureUv,
  getQaGateCommands,
  getSupportedGreenfieldStacks,
  supportsGreenfieldScaffold,
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

  it("creates a project-local Python virtualenv and installs dev extras when uv is unavailable", async () => {
    const repoPath = await makeTempRepo("fabrica-python-bootstrap-");
    await fs.writeFile(path.join(repoPath, "pyproject.toml"), `
[project]
name = "password-cli"
version = "0.1.0"
[project.optional-dependencies]
dev = ["pytest>=8.0.0"]
`, "utf-8");

    const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const venvPython = path.join(repoPath, ".venv", "bin", "python");
    const result = await ensureProjectTestEnvironment({
      repoPath,
      stack: "python-cli",
      mode: "scaffold",
      runCommand: async (cmd, args, opts) => {
        calls.push({ cmd, args, cwd: opts?.cwd });
        if (cmd === "uv") {
          return { stdout: "", stderr: "missing", exitCode: 127 };
        }
        if (cmd === "python3" && args[0] === "--version") {
          return { stdout: "Python 3.11.0\n", stderr: "", exitCode: 0 };
        }
        if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
          await fs.mkdir(path.dirname(venvPython), { recursive: true });
          await fs.writeFile(venvPython, "", "utf-8");
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (cmd === venvPython) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(result.ready).toBe(true);
    expect(result.environmentPath).toBe(path.join(repoPath, ".venv"));
    expect(calls.some((call) => call.cmd === "python3" && call.args.join(" ") === "-m venv .venv")).toBe(true);
    expect(calls.some((call) => call.cmd === venvPython && call.args.join(" ") === "-m pip install -e .[dev]")).toBe(true);
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

  it("fails closed when uv.lock exists but uv is unavailable", async () => {
    const repoPath = await makeTempRepo("fabrica-uv-lock-");
    await fs.writeFile(path.join(repoPath, "uv.lock"), "version = 1\n", "utf-8");
    await fs.writeFile(path.join(repoPath, "pyproject.toml"), "[project]\nname='x'\nversion='0.1.0'\n", "utf-8");

    const result = await ensureProjectTestEnvironment({
      repoPath,
      stack: "python-cli",
      mode: "qa",
      runCommand: async (cmd) => {
        if (cmd === "uv") return { stdout: "", stderr: "missing", exitCode: 127 };
        if (cmd === "python3") return { stdout: "Python 3.11.0\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toBe("uv_lock_without_uv");
  });

  it("falls back to a repo-local virtualenv bootstrap when stdlib venv is unavailable and uv is missing", async () => {
    const repoPath = await makeTempRepo("fabrica-python-fallback-");
    await fs.writeFile(path.join(repoPath, "pyproject.toml"), `
[project]
name = "password-cli"
version = "0.1.0"
[project.optional-dependencies]
dev = ["pytest>=8.0.0"]
`, "utf-8");

    const calls: Array<{ cmd: string; args: string[]; cwd?: string; env?: Record<string, string | undefined> }> = [];
    const venvPython = path.join(repoPath, ".venv", "bin", "python");
    const result = await ensureProjectTestEnvironment({
      repoPath,
      stack: "python-cli",
      mode: "scaffold",
      runCommand: async (cmd, args, opts) => {
        calls.push({ cmd, args, cwd: opts?.cwd, env: opts?.env });
        if (cmd === "uv") {
          return { stdout: "", stderr: "missing", exitCode: 127 };
        }
        if (cmd === "python3" && args[0] === "--version") {
          return { stdout: "Python 3.11.0\n", stderr: "", exitCode: 0 };
        }
        if (cmd === "python3" && args.join(" ") === "-m venv .venv") {
          return { stdout: "", stderr: "ensurepip missing", exitCode: 1 };
        }
        if (cmd === "python3" && args.join(" ").startsWith("-m pip install --disable-pip-version-check --target")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (cmd === "python3" && args.join(" ") === "-m virtualenv .venv") {
          await fs.mkdir(path.dirname(venvPython), { recursive: true });
          await fs.writeFile(venvPython, "", "utf-8");
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (cmd === venvPython) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(result.ready).toBe(true);
    expect(calls.some((call) => call.cmd === "python3" && call.args.join(" ") === "-m virtualenv .venv")).toBe(true);
    const fallbackCall = calls.find((call) => call.cmd === "python3" && call.args.join(" ") === "-m virtualenv .venv");
    expect(fallbackCall?.env?.PYTHONPATH).toContain(path.join(repoPath, ".fabrica", "python-bootstrap"));
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
