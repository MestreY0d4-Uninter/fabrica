import { describe, expect, it } from "vitest";
import { createTestHarness } from "../../lib/testing/harness.js";
import { projectTick } from "../../lib/services/tick.js";
import { writeProjects } from "../../lib/projects/index.js";
import { DEFAULT_WORKFLOW, ReviewPolicy } from "../../lib/workflow/index.js";

describe("projectTick canonical PR binding", () => {
  it("moves reviewer work back to follow-up when there is no canonical PR bound", async () => {
    const h = await createTestHarness({
      workflow: {
        ...DEFAULT_WORKFLOW,
        reviewPolicy: ReviewPolicy.AGENT,
      },
    });
    try {
      h.provider.seedIssue({ iid: 7, title: "Needs review", labels: ["To Review", "review:agent"] });
      h.provider.setPrStatus(7, {
        number: 70,
        state: "open",
        url: "https://example.com/pr/70",
        currentIssueMatch: true,
      });

      const result = await projectTick({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        provider: h.provider,
        targetRole: "reviewer",
        workflow: {
          ...DEFAULT_WORKFLOW,
          reviewPolicy: ReviewPolicy.AGENT,
        },
        runCommand: h.runCommand,
      });

      expect(result.pickups).toHaveLength(0);
      expect(result.skipped.some((entry) => entry.reason.includes("canonical"))).toBe(true);
      const issue = await h.provider.getIssue(7);
      expect(issue.labels).toContain("To Improve");
    } finally {
      await h.cleanup();
    }
  });

  it("dispatches reviewer when the issue has a canonical PR binding", async () => {
    const h = await createTestHarness({
      workflow: {
        ...DEFAULT_WORKFLOW,
        reviewPolicy: ReviewPolicy.AGENT,
      },
    });
    try {
      h.provider.seedIssue({ iid: 8, title: "Needs review", labels: ["To Review", "review:agent"] });
      h.provider.setPrStatus(8, {
        number: 80,
        state: "open",
        url: "https://example.com/pr/80",
        currentIssueMatch: true,
      });
      const data = await h.readProjects();
      data.projects[h.project.slug]!.issueRuntime = {
        "8": {
          currentPrNumber: 80,
          currentPrState: "open",
          currentPrIssueTarget: 8,
        },
      };
      await writeProjects(h.workspaceDir, data);

      const result = await projectTick({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        provider: h.provider,
        targetRole: "reviewer",
        workflow: {
          ...DEFAULT_WORKFLOW,
          reviewPolicy: ReviewPolicy.AGENT,
        },
        runCommand: h.runCommand,
      });

      expect(result.pickups).toHaveLength(1);
      expect(result.pickups[0]?.role).toBe("reviewer");
    } finally {
      await h.cleanup();
    }
  });
});
