import { describe, expect, it } from "vitest";
import { createTestHarness } from "../../lib/testing/harness.js";
import { reviewPass } from "../../lib/services/heartbeat/review.js";
import { testSkipPass } from "../../lib/services/heartbeat/test-skip.js";
import { Action, DEFAULT_WORKFLOW, ReviewPolicy } from "../../lib/workflow/index.js";

describe("heartbeat canonical PR alignment", () => {
  it("reviewPass uses the canonical PR selector bound in issue runtime", async () => {
    const h = await createTestHarness({
      workflow: {
        ...DEFAULT_WORKFLOW,
        reviewPolicy: ReviewPolicy.HUMAN,
      },
    });

    try {
      h.provider.seedIssue({ iid: 9, title: "Review canonical PR", labels: ["To Review", "review:human"] });
      h.provider.setPrStatus(9, {
        number: 99,
        state: "open",
        url: "https://example.com/pr/99",
        currentIssueMatch: true,
      });
      h.provider.prStatuses.set(901, {
        number: 11,
        state: "approved",
        url: "https://example.com/pr/11",
        currentIssueMatch: true,
      });

      const data = await h.readProjects();
      data.projects[h.project.slug]!.issueRuntime = {
        "9": {
          currentPrNumber: 11,
          currentPrState: "open",
          currentPrUrl: "https://example.com/pr/11",
          currentPrIssueTarget: 9,
        },
      };
      await h.writeProjects(data);

      const transitions = await reviewPass({
        workspaceDir: h.workspaceDir,
        projectName: h.project.name,
        workflow: {
          ...DEFAULT_WORKFLOW,
          reviewPolicy: ReviewPolicy.HUMAN,
        },
        provider: h.provider,
        repoPath: h.project.repo,
        runCommand: h.runCommand,
      });

      expect(transitions).toBe(1);
      const issue = await h.provider.getIssue(9);
      expect(issue.labels).toContain("To Test");
      expect(
        h.provider.callsTo("getPrStatus").some((call) => call.args.issueId === 9 && call.args.selector?.prNumber === 11),
      ).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it("testSkipPass does not apply a terminal transition when close guard blocks", async () => {
    const workflow = {
      ...DEFAULT_WORKFLOW,
      states: {
        ...DEFAULT_WORKFLOW.states,
        toTest: {
          ...DEFAULT_WORKFLOW.states.toTest,
          on: {
            ...DEFAULT_WORKFLOW.states.toTest.on,
            SKIP: {
              target: "done",
              actions: [Action.CLOSE_ISSUE],
            },
          },
        },
      },
    };

    const h = await createTestHarness({ workflow });

    try {
      h.provider.seedIssue({ iid: 12, title: "Skip QA close guard", labels: ["To Test", "test:skip"] });
      h.provider.setPrStatus(12, {
        number: 120,
        state: "closed",
        url: null,
      });
      h.provider.prStatuses.set(1201, {
        number: 44,
        state: "open",
        url: "https://example.com/pr/44",
        currentIssueMatch: true,
      });

      const data = await h.readProjects();
      data.projects[h.project.slug]!.issueRuntime = {
        "12": {
          currentPrNumber: 44,
          currentPrState: "open",
          currentPrUrl: "https://example.com/pr/44",
          currentPrIssueTarget: 12,
        },
      };
      await h.writeProjects(data);

      const transitions = await testSkipPass({
        workspaceDir: h.workspaceDir,
        projectName: h.project.name,
        workflow,
        provider: h.provider,
      });

      expect(transitions).toBe(0);
      const issue = await h.provider.getIssue(12);
      expect(issue.labels).toContain("To Test");
      expect(issue.labels).not.toContain("Done");
      expect(h.provider.callsTo("closeIssue")).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });
});
