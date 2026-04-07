import { describe, expect, it } from "vitest";
import { createTestHarness } from "../../lib/testing/harness.js";
import { executeCompletion } from "../../lib/services/pipeline.js";
import { writeProjects } from "../../lib/projects/index.js";
import { DEFAULT_WORKFLOW, type WorkflowConfig } from "../../lib/workflow/index.js";

describe("closeIssue invariant", () => {
  it("refuses to close when there is no meaningful completion evidence", async () => {
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
        tester: { active: true, issueId: "30", level: "medior" },
      },
    });

    try {
      h.provider.seedIssue({ iid: 30, title: "Evidence required", labels: ["Testing"] });

      await expect(executeCompletion({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        channels: h.project.channels,
        role: "tester",
        result: "pass",
        issueId: 30,
        summary: "ok",
        provider: h.provider,
        repoPath: h.project.repo,
        projectName: h.project.name,
        workflow: unsafeWorkflow,
        runCommand: h.runCommand,
      })).rejects.toThrow(/meaningful completion evidence/);

      const issue = await h.provider.getIssue(30);
      expect(issue.state).toBe("opened");
      expect(issue.labels).toContain("Testing");
      expect(h.provider.callsTo("closeIssue")).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  it("allows CLI close when canonical PR evidence already exists in runtime even if the tester summary is weak", async () => {
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
        tester: { active: true, issueId: "30", level: "medior" },
      },
    });

    try {
      h.provider.seedIssue({ iid: 30, title: "CLI canonical PR evidence", labels: ["Testing"] });
      const data = await h.readProjects();
      data.projects[h.project.slug]!.stack = "python-cli";
      data.projects[h.project.slug]!.issueRuntime = {
        "30": {
          currentPrNumber: 300,
          currentPrState: "merged",
          currentPrUrl: "https://example.com/pr/300",
          currentPrIssueTarget: 30,
          artifactOfRecord: {
            prNumber: 300,
            headSha: "abc12345",
            mergedAt: "2026-04-07T16:00:00Z",
            url: "https://example.com/pr/300",
          },
        },
      };
      await writeProjects(h.workspaceDir, data);

      await executeCompletion({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        channels: h.project.channels,
        role: "tester",
        result: "pass",
        issueId: 30,
        summary: "ok",
        provider: h.provider,
        repoPath: h.project.repo,
        projectName: h.project.name,
        workflow: unsafeWorkflow,
        runCommand: h.runCommand,
      });

      const issue = await h.provider.getIssue(30);
      expect(issue.state).toBe("closed");
      expect(h.provider.callsTo("closeIssue")).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  it("refuses to close a CLI issue when the summary lacks CLI-specific evidence", async () => {
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
        tester: { active: true, issueId: "30", level: "medior" },
      },
    });

    try {
      h.provider.seedIssue({ iid: 30, title: "CLI evidence required", labels: ["Testing"] });
      const data = await h.readProjects();
      data.projects[h.project.slug]!.stack = "python-cli";
      await writeProjects(h.workspaceDir, data);

      await expect(executeCompletion({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        channels: h.project.channels,
        role: "tester",
        result: "pass",
        issueId: 30,
        summary: "Everything looks correct and complete now.",
        provider: h.provider,
        repoPath: h.project.repo,
        projectName: h.project.name,
        workflow: unsafeWorkflow,
        runCommand: h.runCommand,
      })).rejects.toThrow(/specific evidence/i);

      const issue = await h.provider.getIssue(30);
      expect(issue.state).toBe("opened");
      expect(issue.labels).toContain("Testing");
      expect(h.provider.callsTo("closeIssue")).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  it("refuses to close an implementation issue while the canonical PR is still open", async () => {
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
        tester: { active: true, issueId: "31", level: "medior" },
      },
    });

    try {
      h.provider.seedIssue({ iid: 31, title: "Verify signup", labels: ["Testing"] });
      h.provider.setPrStatus(31, {
        number: 310,
        state: "open",
        url: "https://example.com/pr/310",
        currentIssueMatch: true,
      });

      const data = await h.readProjects();
      data.projects[h.project.slug]!.issueRuntime = {
        "31": {
          currentPrNumber: 310,
          currentPrState: "open",
          currentPrUrl: "https://example.com/pr/310",
          currentPrIssueTarget: 31,
        },
      };
      await writeProjects(h.workspaceDir, data);

      await expect(executeCompletion({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        channels: h.project.channels,
        role: "tester",
        result: "pass",
        issueId: 31,
        summary: "All tests pass",
        provider: h.provider,
        repoPath: h.project.repo,
        projectName: h.project.name,
        workflow: unsafeWorkflow,
        runCommand: h.runCommand,
      })).rejects.toThrow(/Refusing to close issue #31 while canonical PR #310 is still open/);

      const issue = await h.provider.getIssue(31);
      expect(issue.state).toBe("opened");
      expect(issue.labels).toContain("Testing");
      expect(h.provider.callsTo("closeIssue")).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  it("refuses to close when follow-up work still requires a new canonical PR", async () => {
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
        tester: { active: true, issueId: "32", level: "medior" },
      },
    });

    try {
      h.provider.seedIssue({ iid: 32, title: "Follow-up required", labels: ["Testing"] });
      h.provider.setPrStatus(32, {
        state: "merged",
        url: "https://example.com/pr/320",
        currentIssueMatch: true,
      });

      const data = await h.readProjects();
      data.projects[h.project.slug]!.issueRuntime = {
        "32": {
          currentPrNumber: null,
          currentPrState: null,
          currentPrUrl: null,
          currentPrIssueTarget: 32,
          followUpPrRequired: true,
        },
      };
      await writeProjects(h.workspaceDir, data);

      await expect(executeCompletion({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        channels: h.project.channels,
        role: "tester",
        result: "pass",
        issueId: 32,
        summary: "Tests passed but a new PR is still required",
        provider: h.provider,
        repoPath: h.project.repo,
        projectName: h.project.name,
        workflow: unsafeWorkflow,
        runCommand: h.runCommand,
      })).rejects.toThrow(/follow-up work still requires a canonical PR/);

      const issue = await h.provider.getIssue(32);
      expect(issue.state).toBe("opened");
      expect(issue.labels).toContain("Testing");
      expect(h.provider.callsTo("closeIssue")).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  it("refuses to close a PR-backed issue without a confirmed artifact of record", async () => {
    // When the PR is closed (not merged) and no artifactOfRecord exists,
    // the guard blocks the close. Note: if the live API confirms the PR
    // as "merged", the guard now allows the close even without an
    // artifactOfRecord (since API confirmation IS the proof of merge).
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
        tester: { active: true, issueId: "33", level: "medior" },
      },
    });

    try {
      h.provider.seedIssue({ iid: 33, title: "Closed but not recorded", labels: ["Testing"] });
      // PR is closed (NOT merged) — so API does not confirm merge
      h.provider.setPrStatus(33, {
        number: 330,
        state: "closed",
        url: "https://example.com/pr/330",
        currentIssueMatch: true,
      });

      const data = await h.readProjects();
      data.projects[h.project.slug]!.issueRuntime = {
        "33": {
          currentPrNumber: 330,
          currentPrState: "closed",
          currentPrUrl: "https://example.com/pr/330",
          currentPrIssueTarget: 33,
          lastHeadSha: "deadbeef",
          lastRunId: "330:deadbeef",
          lastCheckRunId: 991,
        },
      };
      await writeProjects(h.workspaceDir, data);

      await expect(executeCompletion({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        channels: h.project.channels,
        role: "tester",
        result: "pass",
        issueId: 33,
        summary: "Tests passed",
        provider: h.provider,
        repoPath: h.project.repo,
        projectName: h.project.name,
        workflow: unsafeWorkflow,
        runCommand: h.runCommand,
      })).rejects.toThrow(/without a confirmed artifact of record/);

      expect(h.provider.callsTo("closeIssue")).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  it("allows close once artifact of record is confirmed", async () => {
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
        tester: { active: true, issueId: "34", level: "medior" },
      },
    });

    try {
      h.provider.seedIssue({ iid: 34, title: "Merged and recorded", labels: ["Testing"] });
      h.provider.setPrStatus(34, {
        number: 340,
        state: "merged",
        url: "https://example.com/pr/340",
        currentIssueMatch: true,
      });

      const data = await h.readProjects();
      data.projects[h.project.slug]!.issueRuntime = {
        "34": {
          currentPrNumber: 340,
          currentPrState: "merged",
          currentPrUrl: "https://example.com/pr/340",
          currentPrIssueTarget: 34,
          lastHeadSha: "cafebabe",
          artifactOfRecord: {
            prNumber: 340,
            headSha: "cafebabe",
            mergedAt: "2026-03-13T12:00:00Z",
            url: "https://example.com/pr/340",
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
        issueId: 34,
        summary: "Tests passed",
        provider: h.provider,
        repoPath: h.project.repo,
        projectName: h.project.name,
        workflow: unsafeWorkflow,
        runCommand: h.runCommand,
      });

      expect(output.issueClosed).toBe(true);
      expect(h.provider.callsTo("closeIssue")).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });
});
