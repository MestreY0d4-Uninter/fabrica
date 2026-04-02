import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../lib/projects/types.js";
import {
  getProjectEnvironmentState,
  resolveEnvironmentContractVersion,
} from "../../lib/test-env/state.js";
import { resolveStackEnvironmentContract } from "../../lib/test-env/contracts.js";
import { createTestHarness } from "../../lib/testing/harness.js";
import { ensureEnvironmentReady } from "../../lib/test-env/runtime.js";

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
    } finally {
      await h.cleanup();
    }
  });
});
