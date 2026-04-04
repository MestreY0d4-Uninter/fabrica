import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../lib/projects/types.js";
import {
  getProjectEnvironmentState,
  resolveEnvironmentContractVersion,
} from "../../lib/test-env/state.js";
import { resolveStackEnvironmentContract } from "../../lib/test-env/contracts.js";
import { createTestHarness } from "../../lib/testing/harness.js";
import { ensureEnvironmentReady } from "../../lib/test-env/runtime.js";
import { DATA_DIR } from "../../lib/setup/constants.js";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    slug: "todo-summary",
    name: "todo-summary",
    repo: "MestreY0d4-Uninter/todo-summary",
    groupName: "Test",
    deployUrl: "",
    baseBranch: "main",
    deployBranch: "main",
    channels: [],
    workers: {},
    ...overrides,
  };
}

async function readAuditEvents(workspaceDir: string): Promise<Array<Record<string, unknown>>> {
  const filePath = path.join(workspaceDir, DATA_DIR, "log", "audit.log");
  const content = await fs.readFile(filePath, "utf-8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("environment state defaults", () => {
  it("defaults a python project environment to pending with the resolved contract version", () => {
    const state = getProjectEnvironmentState(makeProject(), "python-cli");
    expect(state).toMatchObject({
      status: "pending",
      stack: "python-cli",
      contractVersion: resolveEnvironmentContractVersion("python-cli"),
      provisioningStartedAt: null,
      lastProvisionError: null,
      nextProvisionRetryAt: null,
    });
  });

  it("keeps a ready state stable when the stored contract version already matches", () => {
    const state = getProjectEnvironmentState(makeProject({
      environment: {
        status: "ready",
        stack: "python-cli",
        contractVersion: resolveEnvironmentContractVersion("python-cli"),
        provisioningStartedAt: null,
        lastProvisionedAt: "2026-04-02T00:00:00.000Z",
        lastProvisionError: null,
        nextProvisionRetryAt: null,
      },
    }), "python-cli");

    expect(state.status).toBe("ready");
    expect(state.contractVersion).toBe(resolveEnvironmentContractVersion("python-cli"));
  });
});

describe("stack contract resolution", () => {
  it("resolves a Python contract that requires shared toolchain and project environment steps", () => {
    const contract = resolveStackEnvironmentContract("python-cli");
    expect(contract.family).toBe("python");
    expect(contract.version).toBe(resolveEnvironmentContractVersion("python-cli"));
    expect(contract.requiresSharedToolchain).toBe(true);
  });
});

describe("ensureEnvironmentReady", () => {
  it("reuses a cached Node environment without rerunning install commands", async () => {
    const h = await createTestHarness();
    try {
      const data = await h.readProjects();
      const repoPath = path.join(h.workspaceDir, "tmp-node-cached");
      await fs.mkdir(path.join(repoPath, "node_modules"), { recursive: true });
      await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({
        name: "todo-summary",
        private: true,
      }, null, 2), "utf-8");
      await fs.writeFile(path.join(repoPath, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }, null, 2), "utf-8");
      await fs.mkdir(path.join(repoPath, ".fabrica"), { recursive: true });

      const fingerprint = createHash("sha256")
        .update("package-lock.json\n")
        .update(await fs.readFile(path.join(repoPath, "package-lock.json")))
        .update("\n")
        .update("package.json\n")
        .update(await fs.readFile(path.join(repoPath, "package.json")))
        .update("\n")
        .digest("hex");
      await fs.writeFile(path.join(repoPath, ".fabrica", "test-env.sha256"), fingerprint, "utf-8");

      data.projects[h.project.slug]!.stack = "node-cli";
      data.projects[h.project.slug]!.repo = repoPath;
      await h.writeProjects(data);

      const runCommand = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
      const result = await ensureEnvironmentReady({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        project: data.projects[h.project.slug]!,
        stack: "node-cli",
        mode: "developer",
        runCommand,
      });

      expect(result.ready).toBe(true);
      expect(result.state.status).toBe("ready");
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      await h.cleanup();
    }
  });

  it("persists a ready Node environment after npm ci succeeds", async () => {
    const h = await createTestHarness();
    try {
      const data = await h.readProjects();
      const repoPath = path.join(h.workspaceDir, "tmp-node-lock");
      await fs.mkdir(repoPath, { recursive: true });
      await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({
        name: "todo-summary",
        private: true,
      }, null, 2), "utf-8");
      await fs.writeFile(path.join(repoPath, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }, null, 2), "utf-8");

      data.projects[h.project.slug]!.stack = "node-cli";
      data.projects[h.project.slug]!.repo = repoPath;
      await h.writeProjects(data);

      const runCommand = vi.fn(async (argv: string[]) => {
        const [cmd, ...args] = argv;
        if (cmd === "npm" && args[0] === "--version") {
          return { stdout: "10.8.0", stderr: "", code: 0 };
        }
        if (cmd === "npm" && args[0] === "ci") {
          await fs.mkdir(path.join(repoPath, "node_modules"), { recursive: true });
          return { stdout: "", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      });

      const result = await ensureEnvironmentReady({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        project: data.projects[h.project.slug]!,
        stack: "node-cli",
        mode: "developer",
        runCommand,
      });

      expect(result.ready).toBe(true);
      expect(result.state.status).toBe("ready");
      expect(runCommand).toHaveBeenCalledWith(expect.arrayContaining(["npm", "ci"]), expect.anything());

      const updated = await h.readProjects();
      expect(updated.projects[h.project.slug]!.environment).toMatchObject({
        status: "ready",
        stack: "node-cli",
        contractVersion: resolveEnvironmentContractVersion("node-cli"),
      });
    } finally {
      await h.cleanup();
    }
  });

  it("fails closed for Node repos without a lockfile in developer mode", async () => {
    const h = await createTestHarness();
    try {
      const data = await h.readProjects();
      const repoPath = path.join(h.workspaceDir, "tmp-node-no-lock");
      await fs.mkdir(repoPath, { recursive: true });
      await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({
        name: "todo-summary",
        private: true,
      }, null, 2), "utf-8");

      data.projects[h.project.slug]!.stack = "node-cli";
      data.projects[h.project.slug]!.repo = repoPath;
      await h.writeProjects(data);

      const runCommand = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
      const result = await ensureEnvironmentReady({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        project: data.projects[h.project.slug]!,
        stack: "node-cli",
        mode: "developer",
        runCommand,
      });

      expect(result.ready).toBe(false);
      expect(result.state.status).toBe("failed");
      expect(result.state.lastProvisionError).toBe("missing_lockfile_for_reproducible_test_bootstrap");
      expect(result.state.nextProvisionRetryAt).toEqual(expect.any(String));
    } finally {
      await h.cleanup();
    }
  });

  it("converts npm ci failures into retryable Node failed state", async () => {
    const h = await createTestHarness();
    try {
      const data = await h.readProjects();
      const repoPath = path.join(h.workspaceDir, "tmp-node-ci-fail");
      await fs.mkdir(repoPath, { recursive: true });
      await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({
        name: "todo-summary",
        private: true,
      }, null, 2), "utf-8");
      await fs.writeFile(path.join(repoPath, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }, null, 2), "utf-8");

      data.projects[h.project.slug]!.stack = "node-cli";
      data.projects[h.project.slug]!.repo = repoPath;
      await h.writeProjects(data);

      const runCommand = vi.fn(async (argv: string[]) => {
        const [cmd, ...args] = argv;
        if (cmd === "npm" && args[0] === "--version") {
          return { stdout: "10.8.0", stderr: "", code: 0 };
        }
        if (cmd === "npm" && args[0] === "ci") {
          return { stdout: "", stderr: "lockfile corruption", code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
      });

      const result = await ensureEnvironmentReady({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        project: data.projects[h.project.slug]!,
        stack: "node-cli",
        mode: "developer",
        runCommand,
      });

      expect(result.ready).toBe(false);
      expect(result.state.status).toBe("failed");
      expect(result.state.lastProvisionError).toContain("Dependency bootstrap failed");
      expect(result.state.lastProvisionError).toContain("lockfile corruption");
      expect(result.state.nextProvisionRetryAt).toEqual(expect.any(String));
    } finally {
      await h.cleanup();
    }
  });

  it("treats a persisted provisioning state as blocking without re-running bootstrap", async () => {
    const h = await createTestHarness();
    try {
      const data = await h.readProjects();
      data.projects[h.project.slug]!.stack = "python-cli";
      data.projects[h.project.slug]!.environment = {
        status: "provisioning",
        stack: "python-cli",
        contractVersion: resolveEnvironmentContractVersion("python-cli"),
        provisioningStartedAt: new Date().toISOString(),
        lastProvisionedAt: null,
        lastProvisionError: null,
        nextProvisionRetryAt: null,
      };
      await h.writeProjects(data);

      const runCommand = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
      const result = await ensureEnvironmentReady({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        project: data.projects[h.project.slug]!,
        stack: "python-cli",
        mode: "developer",
        runCommand,
      });

      expect(result.ready).toBe(false);
      expect(result.state.status).toBe("provisioning");
      expect(runCommand).not.toHaveBeenCalled();

      const events = await readAuditEvents(h.workspaceDir);
      expect(events).toContainEqual(expect.objectContaining({
        event: "environment_bootstrap_blocked",
        projectSlug: h.project.slug,
        mode: "developer",
        reason: "provisioning_in_progress",
      }));
    } finally {
      await h.cleanup();
    }
  });

  it("retries a stale persisted provisioning state instead of blocking forever", async () => {
    const h = await createTestHarness();
    try {
      const data = await h.readProjects();
      data.projects[h.project.slug]!.stack = "python-cli";
      data.projects[h.project.slug]!.environment = {
        status: "provisioning",
        stack: "python-cli",
        contractVersion: resolveEnvironmentContractVersion("python-cli"),
        provisioningStartedAt: "2026-04-02T00:00:00.000Z",
        lastProvisionedAt: null,
        lastProvisionError: null,
        nextProvisionRetryAt: null,
      };
      await h.writeProjects(data);

      const runCommand = vi.fn(async (cmd: string) => {
        if (cmd === "uv") return { stdout: "uv 0.7.2", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "missing_pyproject_or_requirements", exitCode: 1 };
      });

      const result = await ensureEnvironmentReady({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        project: data.projects[h.project.slug]!,
        stack: "python-cli",
        mode: "developer",
        runCommand,
      });

      expect(runCommand).toHaveBeenCalled();
      expect(result.ready).toBe(false);
      expect(result.state.status).toBe("failed");
      expect(result.state.provisioningStartedAt).toBeNull();
    } finally {
      await h.cleanup();
    }
  });

  it("returns pending failure without re-running bootstrap before nextProvisionRetryAt", async () => {
    const h = await createTestHarness();
    try {
      const data = await h.readProjects();
      data.projects[h.project.slug]!.stack = "python-cli";
      data.projects[h.project.slug]!.environment = {
        status: "failed",
        stack: "python-cli",
        contractVersion: resolveEnvironmentContractVersion("python-cli"),
        provisioningStartedAt: null,
        lastProvisionedAt: null,
        lastProvisionError: "environment_bootstrap_failed",
        nextProvisionRetryAt: new Date(Date.now() + 60_000).toISOString(),
      };
      await h.writeProjects(data);

      const runCommand = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
      const result = await ensureEnvironmentReady({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        project: data.projects[h.project.slug]!,
        stack: "python-cli",
        mode: "developer",
        runCommand,
      });

      expect(result.ready).toBe(false);
      expect(result.state.status).toBe("failed");
      expect(runCommand).not.toHaveBeenCalled();

      const events = await readAuditEvents(h.workspaceDir);
      expect(events).toContainEqual(expect.objectContaining({
        event: "environment_bootstrap_blocked",
        projectSlug: h.project.slug,
        mode: "developer",
        reason: "retry_backoff_active",
        lastProvisionError: "environment_bootstrap_failed",
      }));
    } finally {
      await h.cleanup();
    }
  });

  it("converts bootstrap exceptions into retryable failed state instead of throwing", async () => {
    const h = await createTestHarness();
    try {
      const data = await h.readProjects();
      data.projects[h.project.slug]!.stack = "python-cli";
      await h.writeProjects(data);

      const runCommand = vi.fn(async (argv: string[]) => {
        const [cmd] = argv;
        if (cmd === "uv") return { stdout: "", stderr: "missing", code: 1 };
        if (cmd === "bash") return { stdout: "", stderr: "curl failed", code: 1 };
        return { stdout: "", stderr: "unexpected", code: 1 };
      });

      const result = await ensureEnvironmentReady({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        project: data.projects[h.project.slug]!,
        stack: "python-cli",
        mode: "developer",
        runCommand,
      });

      expect(result.ready).toBe(false);
      expect(result.state.status).toBe("failed");
      expect(result.state.lastProvisionError).toEqual(expect.any(String));
      expect(result.state.lastProvisionError).not.toBe("");
      expect(result.state.nextProvisionRetryAt).toEqual(expect.any(String));

      const updated = await h.readProjects();
      expect(updated.projects[h.project.slug]!.environment).toMatchObject({
        status: "failed",
        stack: "python-cli",
        provisioningStartedAt: null,
        lastProvisionError: expect.any(String),
      });
      expect(updated.projects[h.project.slug]!.environment?.nextProvisionRetryAt).toEqual(expect.any(String));

      const events = await readAuditEvents(h.workspaceDir);
      expect(events).toContainEqual(expect.objectContaining({
        event: "environment_bootstrap_started",
        projectSlug: h.project.slug,
        mode: "developer",
        previousStatus: "pending",
      }));
      expect(events).toContainEqual(expect.objectContaining({
        event: "environment_bootstrap_retry_scheduled",
        projectSlug: h.project.slug,
        mode: "developer",
        retryDelayMs: 60000,
      }));
    } finally {
      await h.cleanup();
    }
  });

  it("records start and ready audit metadata when bootstrap succeeds", async () => {
    const h = await createTestHarness();
    try {
      const data = await h.readProjects();
      const repoPath = path.join(h.workspaceDir, "tmp-python-ready");
      await fs.mkdir(repoPath, { recursive: true });
      await fs.writeFile(path.join(repoPath, "pyproject.toml"), "[project]\nname='todo-summary'\nversion='0.1.0'\n", "utf-8");
      data.projects[h.project.slug]!.stack = "python-cli";
      data.projects[h.project.slug]!.repo = repoPath;
      await h.writeProjects(data);

      const runCommand = vi.fn(async (argv: string[]) => {
        const [cmd, ...args] = argv;
        if (cmd === "uv" && args[0] === "--version") {
          return { stdout: "uv 0.7.2", stderr: "", code: 0 };
        }
        if (cmd === "python3" && args[0] === "--version") {
          return { stdout: "Python 3.12.0", stderr: "", code: 0 };
        }
        if (cmd === "uv" && args[0] === "venv") {
          const target = args[1] === ".venv" ? path.join(repoPath, ".venv") : args[1];
          await fs.mkdir(path.join(target, "bin"), { recursive: true });
          await fs.writeFile(path.join(target, "bin", "python"), "", "utf-8");
          await fs.writeFile(path.join(target, "bin", "ruff"), "#!/bin/sh\n", { mode: 0o755 });
          return { stdout: "", stderr: "", code: 0 };
        }
        if (cmd === "uv" && args[0] === "pip") {
          return { stdout: "", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      });

      const result = await ensureEnvironmentReady({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        project: data.projects[h.project.slug]!,
        stack: "python-cli",
        mode: "tester",
        runCommand,
      });

      expect(result.ready).toBe(true);
      expect(result.state.status).toBe("ready");

      const events = await readAuditEvents(h.workspaceDir);
      expect(events).toContainEqual(expect.objectContaining({
        event: "environment_bootstrap_started",
        projectSlug: h.project.slug,
        mode: "tester",
        previousStatus: "pending",
      }));
      expect(events).toContainEqual(expect.objectContaining({
        event: "environment_ready_confirmed",
        projectSlug: h.project.slug,
        mode: "tester",
        previousStatus: "pending",
        contractVersion: resolveEnvironmentContractVersion("python-cli"),
      }));
    } finally {
      await h.cleanup();
    }
  });
});
