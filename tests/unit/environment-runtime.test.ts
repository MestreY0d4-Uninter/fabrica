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
  it("returns pending failure without re-running bootstrap before nextProvisionRetryAt", async () => {
    const h = await createTestHarness();
    try {
      const data = await h.readProjects();
      data.projects[h.project.slug]!.stack = "python-cli";
      data.projects[h.project.slug]!.environment = {
        status: "failed",
        stack: "python-cli",
        contractVersion: resolveEnvironmentContractVersion("python-cli"),
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
});
