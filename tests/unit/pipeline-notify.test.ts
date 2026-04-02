import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../../lib/testing/harness.js";
import { writeProjects } from "../../lib/projects/index.js";
import { executeCompletion } from "../../lib/services/pipeline.js";
import * as notifyModule from "../../lib/dispatch/notify.js";
import { DEFAULT_WORKFLOW } from "../../lib/workflow/index.js";

describe("pipeline notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("threads dispatch identity into workerComplete notifications", async () => {
    const h = await createTestHarness({ workflow: DEFAULT_WORKFLOW });
    const notifySpy = vi.spyOn(notifyModule, "notify").mockResolvedValue(true as any);
    vi.spyOn(notifyModule, "getNotificationConfig").mockReturnValue({} as any);

    try {
      h.provider.seedIssue({
        iid: 1,
        title: "Cycle-aware notify",
        labels: ["Doing"],
      });

      const data = await h.readProjects();
      data.projects[h.project.slug]!.workers.developer.levels.senior = [
        {
          active: true,
          issueId: "1",
          sessionKey: "agent:test:subagent:cycle-aware-developer",
          startTime: new Date().toISOString(),
          previousLabel: "To Do",
          dispatchCycleId: "cycle-a",
          dispatchRunId: "run-a",
        } as any,
      ];
      data.projects[h.project.slug]!.issueRuntime = {
        "1": {
          dispatchRequestedAt: new Date().toISOString(),
          lastDispatchCycleId: "cycle-a",
          dispatchRunId: "run-a",
        } as any,
      };
      await writeProjects(h.workspaceDir, data);

      await executeCompletion({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        channels: h.project.channels,
        role: "developer",
        result: "done",
        issueId: 1,
        summary: "Finished",
        provider: h.provider,
        repoPath: h.project.repo,
        projectName: h.project.name,
        workflow: DEFAULT_WORKFLOW,
        runCommand: h.runCommand,
      });

      expect(notifySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "workerComplete",
          dispatchCycleId: "cycle-a",
          dispatchRunId: "run-a",
        }),
        expect.any(Object),
      );
    } finally {
      await h.cleanup();
    }
  });
});
