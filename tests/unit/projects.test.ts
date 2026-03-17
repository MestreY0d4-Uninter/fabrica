/**
 * Unit tests for the projects module — slots, mutations, and slug resolution.
 */
import { describe, it, expect } from "vitest";
import {
  emptySlot,
  emptyRoleWorkerState,
  findFreeSlot,
  reconcileSlots,
  findSlotByIssue,
  countActiveSlots,
} from "../../lib/projects/slots.js";
import { resolveProjectSlug, getProject } from "../../lib/projects/io.js";
import type { ProjectsData, Project } from "../../lib/projects/types.js";

// ---------------------------------------------------------------------------
// Slot helpers
// ---------------------------------------------------------------------------

describe("slot helpers", () => {
  it("emptySlot creates inactive slot", () => {
    const slot = emptySlot();
    expect(slot.active).toBe(false);
    expect(slot.issueId).toBeNull();
    expect(slot.sessionKey).toBeNull();
    expect(slot.startTime).toBeNull();
  });

  it("emptyRoleWorkerState creates correct structure", () => {
    const state = emptyRoleWorkerState({ junior: 2, senior: 1 });
    expect(Object.keys(state.levels)).toEqual(["junior", "senior"]);
    expect(state.levels.junior.length).toBe(2);
    expect(state.levels.senior.length).toBe(1);
    expect(state.levels.junior[0].active).toBe(false);
  });

  it("findFreeSlot finds first inactive slot", () => {
    const state = emptyRoleWorkerState({ medior: 3 });
    state.levels.medior[0].active = true;
    state.levels.medior[1].active = true;

    expect(findFreeSlot(state, "medior")).toBe(2);
  });

  it("findFreeSlot returns null when full", () => {
    const state = emptyRoleWorkerState({ medior: 2 });
    state.levels.medior[0].active = true;
    state.levels.medior[1].active = true;

    expect(findFreeSlot(state, "medior")).toBeNull();
  });

  it("findFreeSlot returns null for unknown level", () => {
    const state = emptyRoleWorkerState({ medior: 1 });
    expect(findFreeSlot(state, "unknown")).toBeNull();
  });

  it("reconcileSlots adds missing levels", () => {
    const state = emptyRoleWorkerState({ medior: 1 });
    const changed = reconcileSlots(state, { medior: 1, senior: 2 });
    expect(changed).toBe(true);
    expect(state.levels.senior.length).toBe(2);
  });

  it("reconcileSlots expands short arrays", () => {
    const state = emptyRoleWorkerState({ medior: 1 });
    const changed = reconcileSlots(state, { medior: 3 });
    expect(changed).toBe(true);
    expect(state.levels.medior.length).toBe(3);
  });

  it("reconcileSlots does not remove active workers", () => {
    const state = emptyRoleWorkerState({ medior: 3 });
    state.levels.medior[2].active = true;
    const changed = reconcileSlots(state, { medior: 1 });
    expect(changed).toBe(false); // Can't shrink because last slot is active
    expect(state.levels.medior.length).toBe(3);
  });

  it("findSlotByIssue locates correct slot", () => {
    const state = emptyRoleWorkerState({ medior: 2, senior: 1 });
    state.levels.senior[0].issueId = "42";
    state.levels.senior[0].active = true;

    const found = findSlotByIssue(state, "42");
    expect(found).toEqual({ level: "senior", slotIndex: 0 });
  });

  it("findSlotByIssue returns null when not found", () => {
    const state = emptyRoleWorkerState({ medior: 2 });
    expect(findSlotByIssue(state, "99")).toBeNull();
  });

  it("countActiveSlots counts across levels", () => {
    const state = emptyRoleWorkerState({ junior: 2, senior: 1 });
    state.levels.junior[0].active = true;
    state.levels.senior[0].active = true;
    expect(countActiveSlots(state)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Slug resolution (Patch 1 fix)
// ---------------------------------------------------------------------------

describe("slug resolution", () => {
  const mockProject: Project = {
    slug: "my-project",
    name: "My Project",
    repo: "org/my-project",
    groupName: "org",
    deployUrl: "",
    baseBranch: "main",
    deployBranch: "main",
    channels: [
      { channelId: "-1001234567890", channel: "telegram", name: "primary", events: ["*"] },
    ],
    workers: {},
  };

  const data: ProjectsData = {
    projects: {
      "my-project": mockProject,
    },
  };

  it("resolves by slug directly", () => {
    expect(resolveProjectSlug(data, "my-project")).toBe("my-project");
  });

  it("resolves by channelId", () => {
    expect(resolveProjectSlug(data, "-1001234567890")).toBe("my-project");
  });

  it("fails closed for forum-scoped projects when messageThreadId is missing", () => {
    const forumData: ProjectsData = {
      projects: {
        "forum-project": {
          ...mockProject,
          slug: "forum-project",
          channels: [
            {
              channelId: "-1001234567890",
              channel: "telegram",
              messageThreadId: 42,
              name: "primary",
              events: ["*"],
            },
          ],
        },
      },
    };

    expect(resolveProjectSlug(forumData, "-1001234567890")).toBeUndefined();
    expect(getProject(forumData, "-1001234567890")).toBeUndefined();
    expect(resolveProjectSlug(forumData, "-1001234567890", 42)).toBe("forum-project");
  });

  it("returns undefined for unknown identifier", () => {
    expect(resolveProjectSlug(data, "unknown")).toBeUndefined();
  });

  it("getProject returns project by slug", () => {
    const project = getProject(data, "my-project");
    expect(project).toBeDefined();
    expect(project!.name).toBe("My Project");
  });

  it("getProject returns project by channelId", () => {
    const project = getProject(data, "-1001234567890");
    expect(project).toBeDefined();
    expect(project!.slug).toBe("my-project");
  });

  it("prefers slug over channelId when both exist", () => {
    // If a project slug matches the input, it should return directly
    // without falling into channelId search
    const dataWithConflict: ProjectsData = {
      projects: {
        "my-project": mockProject,
        "-1001234567890": {
          ...mockProject,
          slug: "-1001234567890",
          name: "Channel Project",
        },
      },
    };
    // Direct slug match should win
    expect(resolveProjectSlug(dataWithConflict, "-1001234567890")).toBe("-1001234567890");
  });
});
