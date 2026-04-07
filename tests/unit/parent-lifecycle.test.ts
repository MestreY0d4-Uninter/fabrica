import { describe, expect, it } from "vitest";
import { createTestHarness } from "../../lib/testing/harness.js";
import { executeCompletion } from "../../lib/services/pipeline.js";
import { writeProjects } from "../../lib/projects/index.js";
import { DEFAULT_WORKFLOW, type WorkflowConfig } from "../../lib/workflow/index.js";

describe("parent lifecycle reconciliation", () => {
  it("marks the parent family completed when the final child closes successfully", async () => {
    const unsafeWorkflow = {
      ...DEFAULT_WORKFLOW,
      states: {
        ...DEFAULT_WORKFLOW.states,
        testing: {
          ...DEFAULT_WORKFLOW.states.testing,
          on: {
            ...DEFAULT_WORKFLOW.states.testing.on,
            PASS: {
              target: "done",
              actions: ["closeIssue"],
            },
          },
        },
      },
    } satisfies WorkflowConfig;

    const h = await createTestHarness({
      workflow: unsafeWorkflow,
      workers: {
        tester: { active: true, issueId: "92", level: "medior" },
      },
    });

    try {
      h.provider.seedIssue({ iid: 90, title: "Epic parent", labels: ["To Do"] });
      h.provider.seedIssue({ iid: 92, title: "Final child", labels: ["Testing"] });
      h.provider.setPrStatus(92, {
        number: 920,
        state: "merged",
        url: "https://example.com/pr/920",
        currentIssueMatch: true,
      });

      const data = await h.readProjects();
      data.projects[h.project.slug]!.issueRuntime = {
        "90": {
          childIssueIds: [91, 92],
          decompositionMode: "parent_child",
          decompositionStatus: "active",
        },
        "91": {
          parentIssueId: 90,
          decompositionMode: "none",
          decompositionStatus: "completed",
          sessionCompletedAt: "2026-04-06T10:00:00Z",
          currentPrUrl: "https://example.com/pr/910",
          currentPrState: "open",
          qualityCriticality: "high",
          riskProfile: ["auth"],
        },
        "92": {
          parentIssueId: 90,
          dependencyIssueIds: [91],
          decompositionMode: "none",
          decompositionStatus: null,
          currentPrNumber: 920,
          currentPrState: "merged",
          currentPrUrl: "https://example.com/pr/920",
          currentPrIssueTarget: 92,
          lastHeadSha: "facefeed",
          qualityCriticality: "medium",
          riskProfile: ["data_model"],
          artifactOfRecord: {
            prNumber: 920,
            headSha: "facefeed",
            mergedAt: "2026-04-06T10:10:00Z",
            url: "https://example.com/pr/920",
          },
        },
      };
      await writeProjects(h.workspaceDir, data);

      const output = await executeCompletion({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        channels: h.project.channels,
        role: "tester",
        result: "pass",
        issueId: 92,
        summary: "Final child passed QA",
        provider: h.provider,
        repoPath: h.project.repo,
        projectName: h.project.name,
        workflow: unsafeWorkflow,
        runCommand: h.runCommand,
      });

      expect(output.issueClosed).toBe(true);
      const parentIssue = await h.provider.getIssue(90);
      expect(parentIssue.labels).toContain("Done");
      expect(parentIssue.description).toContain("<!-- fabrica:parent-rollup:start -->");
      expect(parentIssue.description).toContain("High-criticality children: #91");
      expect(parentIssue.description).toContain("#91 — completed_via_session — PR: https://example.com/pr/910");
      expect(parentIssue.description).toContain("qualityCriticality: high");
      expect(parentIssue.description).toContain("risks: auth");
      expect(parentIssue.description).toContain("#92 — completed_via_artifact — PR: https://example.com/pr/920");
      expect(parentIssue.description).toContain("risks: data_model");
      expect(parentIssue.description).toContain("mergedAt: 2026-04-06T10:10:00Z");
      expect(parentIssue.description).toContain("headSha: facefeed");

      const persisted = await h.readProjects();
      const parentRuntime = persisted.projects[h.project.slug]!.issueRuntime?.["90"];
      expect(parentRuntime?.decompositionStatus).toBe("completed");
      expect(parentRuntime?.completedChildIssueIds).toEqual([91, 92]);
      expect(persisted.projects[h.project.slug]!.issueRuntime?.["92"]?.decompositionStatus).toBe("completed");
      expect(h.provider.callsTo("editIssue").some((call) => call.args.issueId === 90 && String(call.args.updates.body).includes("<!-- fabrica:parent-rollup:start -->"))).toBe(true);
      expect(h.provider.callsTo("addComment").filter((call) => call.args.issueId === 90 && String(call.args.body).includes("## Parent Rollup"))).toHaveLength(1);
      expect(h.provider.callsTo("addComment").some((call) => call.args.issueId === 90 && String(call.args.body).includes("## Parent Rollup") && String(call.args.body).includes("#91 — completed_via_session") && String(call.args.body).includes("#92 — completed_via_artifact") && String(call.args.body).includes("mergedAt: 2026-04-06T10:10:00Z") && String(call.args.body).includes("headSha: facefeed"))).toBe(true);
      expect(h.provider.callsTo("addComment").some((call) => call.args.issueId === 90 && String(call.args.body).includes("Parent coordination complete") && String(call.args.body).includes("#92 — completed_via_artifact") && String(call.args.body).includes("headSha: facefeed"))).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});
