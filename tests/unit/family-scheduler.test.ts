import { describe, expect, it } from "vitest";
import { getFamilyDispatchBlockReason } from "../../lib/services/family-scheduler.js";
import type { Project } from "../../lib/projects/types.js";

function makeProject(issueRuntime: Project["issueRuntime"]): Project {
  return {
    slug: "demo",
    name: "demo",
    repo: "/tmp/demo",
    groupName: "Project: demo",
    deployUrl: "",
    baseBranch: "main",
    deployBranch: "main",
    channels: [],
    provider: "github",
    workers: {},
    issueRuntime: issueRuntime ?? {},
    stack: null,
    environment: null,
  };
}

describe("family scheduler", () => {
  it("treats parent issues as coordinator-only work", () => {
    const project = makeProject({
      "42": {
        childIssueIds: [101, 102],
        decompositionMode: "parent_child",
        decompositionStatus: "active",
      },
    });

    expect(getFamilyDispatchBlockReason(project, 42, "developer")).toBe("family_parent_coordinator_only");
    expect(getFamilyDispatchBlockReason(project, 42, "reviewer")).toBe("family_parent_not_executable");
  });

  it("blocks child dispatch while the parent decomposition is not executable", () => {
    const project = makeProject({
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
    });

    expect(getFamilyDispatchBlockReason(project, 101, "developer")).toBe("family_parent_blocked");
  });

  it("allows child dispatch when the parent family is active", () => {
    const project = makeProject({
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
    });

    expect(getFamilyDispatchBlockReason(project, 101, "developer")).toBeNull();
  });

  it("blocks child dispatch while sibling dependencies are still incomplete", () => {
    const project = makeProject({
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
    });

    expect(getFamilyDispatchBlockReason(project, 102, "developer")).toBe("family_child_dependencies_pending:101");

    project.issueRuntime!["101"]!.sessionCompletedAt = new Date().toISOString();
    expect(getFamilyDispatchBlockReason(project, 102, "developer")).toBeNull();
  });
});
