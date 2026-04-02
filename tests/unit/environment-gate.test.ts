import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../../lib/testing/harness.js";
import { projectTick } from "../../lib/services/tick.js";
import { DEFAULT_WORKFLOW, TestPolicy } from "../../lib/workflow/index.js";

describe("projectTick environment gate", () => {
  it("blocks developer dispatch while Python environment provisioning is still pending", async () => {
    const h = await createTestHarness();
    try {
      const data = await h.readProjects();
      data.projects[h.project.slug]!.stack = "python-cli";
      await h.writeProjects(data);

      h.provider.seedIssue({
        iid: 7,
        title: "Implement queued task",
        labels: ["To Do"],
      });

      const ensureEnvironmentReady = vi.fn().mockResolvedValue({
        ready: false,
        state: {
          status: "provisioning",
          stack: "python-cli",
          contractVersion: "python@v1",
          nextProvisionRetryAt: "2026-04-02T12:00:00.000Z",
        },
      });
      const dispatchTask = vi.fn();

      const result = await projectTick({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        targetRole: "developer",
        provider: h.provider,
        workflow: h.workflow,
        runCommand: h.runCommand,
        runtime: {} as never,
        ensureEnvironmentReady,
        dispatchTask,
      });

      expect(ensureEnvironmentReady).toHaveBeenCalledTimes(1);
      expect(dispatchTask).not.toHaveBeenCalled();
      expect(result.skipped).toContainEqual(
        expect.objectContaining({ role: "developer", reason: "environment_not_ready" }),
      );
    } finally {
      await h.cleanup();
    }
  });

  it("passes tester mode to the environment gate before dispatching tester work", async () => {
    const h = await createTestHarness({
      workflow: {
        ...DEFAULT_WORKFLOW,
        testPolicy: TestPolicy.AGENT,
      },
    });
    try {
      const data = await h.readProjects();
      data.projects[h.project.slug]!.stack = "python-cli";
      data.projects[h.project.slug]!.issueRuntime = {
        "7": {
          currentPrNumber: 501,
          currentPrUrl: "https://example.com/pr/501",
          currentPrState: "open",
        },
      };
      await h.writeProjects(data);

      h.provider.seedIssue({
        iid: 7,
        title: "Verify tester environment gate",
        labels: ["To Test"],
      });
      h.provider.setPrStatus(7, {
        number: 501,
        state: "open",
        url: "https://example.com/pr/501",
        currentIssueMatch: true,
      });

      const ensureEnvironmentReady = vi.fn().mockResolvedValue({
        ready: false,
        state: {
          status: "provisioning",
          stack: "python-cli",
          contractVersion: "python@v1",
          nextProvisionRetryAt: "2026-04-02T12:00:00.000Z",
        },
      });

      await projectTick({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        targetRole: "tester",
        provider: h.provider,
        workflow: h.workflow,
        runCommand: h.runCommand,
        ensureEnvironmentReady,
      });

      expect(ensureEnvironmentReady).toHaveBeenCalledWith(expect.objectContaining({
        mode: "tester",
        stack: "python-cli",
      }));
    } finally {
      await h.cleanup();
    }
  });
});
