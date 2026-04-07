import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../../lib/testing/harness.js";
import { projectTick } from "../../lib/services/tick.js";

describe("projectTick family-aware scheduling", () => {
  it("prefers a child issue over a parent coordinator issue in the same developer queue", async () => {
    const h = await createTestHarness({ workers: { developer: { level: "junior", active: false } } });
    try {
      const data = await h.readProjects();
      data.projects[h.project.slug]!.stack = "node-cli";
      data.projects[h.project.slug]!.issueRuntime = {
        "42": {
          childIssueIds: [101],
          decompositionMode: "parent_child",
          decompositionStatus: "active",
        },
        "101": {
          parentIssueId: 42,
          decompositionMode: "none",
          decompositionStatus: null,
        },
      };
      await h.writeProjects(data);

      h.provider.seedIssue({ iid: 42, title: "Epic coordinator", labels: ["To Do", "developer:junior"] });
      h.provider.seedIssue({ iid: 101, title: "Child executable task", labels: ["To Do", "developer:junior"] });

      const dispatchTask = vi.fn();

      const result = await projectTick({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        provider: h.provider,
        targetRole: "developer",
        workflow: h.workflow,
        runCommand: h.runCommand,
        runtime: {} as never,
        dryRun: true,
        dispatchTask: dispatchTask as any,
      });

      expect(result.pickups).toHaveLength(1);
      expect(result.pickups[0]?.issueId).toBe(101);
      expect(dispatchTask).not.toHaveBeenCalled();
    } finally {
      await h.cleanup();
    }
  });

  it("does not dispatch a child when the parent family is blocked", async () => {
    const h = await createTestHarness({ workers: { developer: { level: "junior", active: false } } });
    try {
      const data = await h.readProjects();
      data.projects[h.project.slug]!.stack = "node-cli";
      data.projects[h.project.slug]!.issueRuntime = {
        "42": {
          childIssueIds: [101],
          decompositionMode: "parent_child",
          decompositionStatus: "blocked",
        },
        "101": {
          parentIssueId: 42,
          decompositionMode: "none",
          decompositionStatus: null,
        },
      };
      await h.writeProjects(data);

      h.provider.seedIssue({ iid: 42, title: "Epic coordinator", labels: ["To Do", "developer:junior"] });
      h.provider.seedIssue({ iid: 101, title: "Blocked child task", labels: ["To Do", "developer:junior"] });

      const dispatchTask = vi.fn();

      const result = await projectTick({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        provider: h.provider,
        targetRole: "developer",
        workflow: h.workflow,
        runCommand: h.runCommand,
        runtime: {} as never,
        dryRun: true,
        dispatchTask,
      });

      expect(result.pickups).toHaveLength(0);
      expect(dispatchTask).not.toHaveBeenCalled();
    } finally {
      await h.cleanup();
    }
  });

  it("waits for dependency children before exposing a dependent child to dispatch", async () => {
    const h = await createTestHarness({ workers: { developer: { level: "junior", active: false } } });
    try {
      const data = await h.readProjects();
      data.projects[h.project.slug]!.stack = "node-cli";
      data.projects[h.project.slug]!.issueRuntime = {
        "42": {
          childIssueIds: [101, 102],
          decompositionMode: "parent_child",
          decompositionStatus: "active",
        },
        "101": {
          parentIssueId: 42,
          decompositionMode: "none",
          decompositionStatus: null,
        },
        "102": {
          parentIssueId: 42,
          dependencyIssueIds: [101],
          decompositionMode: "none",
          decompositionStatus: null,
        },
      };
      await h.writeProjects(data);

      h.provider.seedIssue({ iid: 42, title: "Epic coordinator", labels: ["To Do", "developer:junior"] });
      h.provider.seedIssue({ iid: 101, title: "Dependency child", labels: ["To Do", "developer:junior"] });
      h.provider.seedIssue({ iid: 102, title: "Dependent child", labels: ["To Do", "developer:junior"] });

      const updated = await h.readProjects();
      updated.projects[h.project.slug]!.issueRuntime!["101"]!.sessionCompletedAt = new Date().toISOString();
      await h.writeProjects(updated);

      const ready = await projectTick({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        provider: h.provider,
        targetRole: "developer",
        workflow: h.workflow,
        runCommand: h.runCommand,
        runtime: {} as never,
        dryRun: true,
      });
      expect(ready.pickups).toHaveLength(1);
      expect(ready.pickups[0]?.issueId).toBe(102);
    } finally {
      await h.cleanup();
    }
  });

  it("respects the parent family parallel limit even when multiple child issues are otherwise ready", async () => {
    const h = await createTestHarness({ workers: { developer: { level: "junior", active: true, issueId: "101" } } });
    try {
      const data = await h.readProjects();
      data.projects[h.project.slug]!.stack = "node-cli";
      data.projects[h.project.slug]!.issueRuntime = {
        "42": {
          childIssueIds: [101, 102],
          decompositionMode: "parent_child",
          decompositionStatus: "active",
          maxParallelChildren: 1,
        },
        "101": {
          parentIssueId: 42,
          decompositionMode: "none",
          decompositionStatus: null,
        },
        "102": {
          parentIssueId: 42,
          decompositionMode: "none",
          decompositionStatus: null,
        },
      };
      await h.writeProjects(data);

      h.provider.seedIssue({ iid: 101, title: "Already active child", labels: ["Doing", "developer:junior"] });
      h.provider.seedIssue({ iid: 102, title: "Queued sibling child", labels: ["To Do", "developer:junior"] });

      const result = await projectTick({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        provider: h.provider,
        targetRole: "developer",
        workflow: h.workflow,
        runCommand: h.runCommand,
        runtime: {} as never,
        dryRun: true,
      });

      expect(result.pickups).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });
});
