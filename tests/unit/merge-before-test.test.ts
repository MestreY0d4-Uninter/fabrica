import { describe, it, expect } from "vitest";
import { createTestHarness } from "../../lib/testing/harness.js";
import { executeCompletion } from "../../lib/services/pipeline.js";
import { reviewPass } from "../../lib/services/heartbeat/review.js";
import { DEFAULT_WORKFLOW, WorkflowEvent, TestPolicy } from "../../lib/workflow/index.js";

function legacyReviewerMergeWorkflow() {
  return {
    ...DEFAULT_WORKFLOW,
    testPolicy: TestPolicy.AGENT,
    states: {
      ...DEFAULT_WORKFLOW.states,
      toReview: {
        ...DEFAULT_WORKFLOW.states.toReview,
        on: {
          ...DEFAULT_WORKFLOW.states.toReview.on,
          [WorkflowEvent.APPROVED]: {
            target: "toTest",
            actions: ["mergePr", "gitPull", "reopenIssue"],
          },
        },
      },
      reviewing: {
        ...DEFAULT_WORKFLOW.states.reviewing,
        on: {
          ...DEFAULT_WORKFLOW.states.reviewing.on,
          [WorkflowEvent.APPROVE]: {
            target: "toTest",
            actions: ["mergePr", "gitPull", "reopenIssue"],
          },
        },
      },
    },
  };
}

describe("merge-before-test guard rails", () => {
  it("does not merge on reviewer approve even if workflow passed to executeCompletion still contains mergePr", async () => {
    const workflow = legacyReviewerMergeWorkflow();
    const h = await createTestHarness({ workflow });
    try {
      h.provider.seedIssue({ iid: 1, title: "Task", labels: ["Reviewing"] });
      h.provider.setPrStatus(1, { state: "open", url: "https://example.com/pr/1" });

      await executeCompletion({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        role: "reviewer",
        result: "approve",
        issueId: 1,
        summary: "ok",
        provider: h.provider,
        repoPath: h.project.repo,
        projectName: h.project.name,
        channels: h.project.channels,
        workflow,
        runCommand: h.runCommand,
      });

      expect(h.provider.callsTo("mergePr")).toHaveLength(0);
      const issue = await h.provider.getIssue(1);
      expect(issue.labels).toContain("To Test");
    } finally {
      await h.cleanup();
    }
  });

  it("does not merge on heartbeat review pass when testPolicy is agent", async () => {
    const workflow = legacyReviewerMergeWorkflow();
    const h = await createTestHarness({ workflow });
    try {
      h.provider.seedIssue({ iid: 2, title: "Task", labels: ["To Review", "review:human"] });
      h.provider.setPrStatus(2, { state: "approved", url: "https://example.com/pr/2" });

      const transitions = await reviewPass({
        workspaceDir: h.workspaceDir,
        projectName: h.project.name,
        workflow,
        provider: h.provider,
        repoPath: h.project.repo,
        runCommand: h.runCommand,
      });

      expect(transitions).toBe(1);
      expect(h.provider.callsTo("mergePr")).toHaveLength(0);
      const issue = await h.provider.getIssue(2);
      expect(issue.labels).toContain("To Test");
    } finally {
      await h.cleanup();
    }
  });
});
