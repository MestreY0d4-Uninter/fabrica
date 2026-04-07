import { describe, expect, it } from "vitest";
import {
  getChildIssueRuntimes,
  getParentIssueRuntime,
  isChildIssue,
  isParentIssue,
} from "../../lib/projects/index.js";
import type { IssueRuntimeState, Project } from "../../lib/projects/types.js";

describe("project parent/child runtime metadata", () => {
  it("supports decomposition metadata on parent runtime", () => {
    const runtime: IssueRuntimeState = {
      childIssueIds: [11, 12],
      decompositionMode: "parent_child",
      decompositionStatus: "active",
    };

    expect(runtime.childIssueIds).toEqual([11, 12]);
    expect(runtime.decompositionMode).toBe("parent_child");
    expect(runtime.decompositionStatus).toBe("active");
  });

  it("exposes canonical parent child helper behavior", () => {
    const project = {
      issueRuntime: {
        "10": {
          childIssueIds: [11, 12],
          decompositionMode: "parent_child",
          decompositionStatus: "active",
        },
        "11": { parentIssueId: 10 },
        "12": { parentIssueId: 10 },
      },
    } as Project;

    expect(isParentIssue(project, 10)).toBe(true);
    expect(isParentIssue(project, 11)).toBe(false);
    expect(isChildIssue(project, 11)).toBe(true);
    expect(isChildIssue(project, 10)).toBe(false);
    expect(getParentIssueRuntime(project, 11)?.childIssueIds).toEqual([11, 12]);
    expect(getChildIssueRuntimes(project, 10).map((x) => x.issueId)).toEqual([11, 12]);
  });
});
