import { describe, expect, it } from "vitest";
import { buildDecompositionChildDrafts } from "../../lib/intake/lib/decomposition-planner.js";
import type { Spec } from "../../lib/intake/types.js";

describe("decomposition planner", () => {
  it("groups large work into capability-oriented child drafts with execution metadata", () => {
    const spec: Spec = {
      title: "Task Manager API",
      type: "feature",
      objective: "Build a production-ready task management API with auth, projects, task assignment, reminders, and reliable delivery workflows.",
      scope_v1: [
        "Implement authentication endpoints with JWT and protected routes",
        "Implement project CRUD endpoints and membership rules with tests",
        "Implement task CRUD, assignment, and status transitions",
        "Implement overdue reminder processing with a background worker",
      ],
      out_of_scope: ["Mobile application"],
      acceptance_criteria: [
        "should allow authenticated users to create and manage projects",
        "returns task assignment updates through API endpoints",
        "sends overdue reminders using the background worker",
      ],
      definition_of_done: ["tests cover core endpoints", "documentation explains the workflow", "qa script passes"],
      constraints: "Use Python/FastAPI",
      risks: ["auth", "background-worker"],
      delivery_target: "api",
    };

    const drafts = buildDecompositionChildDrafts(spec, 42, "large");

    expect(drafts).toHaveLength(3);
    expect(drafts.map((draft) => draft.title)).toEqual(expect.arrayContaining([
      "Task Manager API — Authentication & Access",
      "Task Manager API — Data Model & Persistence",
    ]));
    expect(drafts.some((draft) => draft.title.includes("Background Jobs & Automation") || draft.title.includes("API & Application Flow"))).toBe(true);
    expect(drafts[0]?.recommendedLevel).toBe("senior");
    expect(drafts[0]?.parallelizable).toBe(false);
    expect(drafts[1]?.dependencyIndexes).toContain(0);
    expect(drafts[1]?.dependencyHints.join(" ")).toContain("authentication");
    expect(drafts[2]?.description).toContain("## Execution Profile");
    expect(drafts[2]?.description).toContain("## Capability Area");
    expect(drafts[2]?.description).toContain("## Out of Scope");
    expect(drafts[2]?.description).toContain("Use Python/FastAPI");
  });

  it("falls back to a balanced split when all scope items belong to the same capability area", () => {
    const spec: Spec = {
      title: "Dashboard UX Refresh",
      type: "feature",
      objective: "Refresh the dashboard experience so operators can review, edit, and confirm changes with clear visual feedback.",
      scope_v1: [
        "Implement dashboard overview page",
        "Implement project edit screen",
        "Implement status detail view",
        "Implement confirmation form and success UI",
      ],
      out_of_scope: [],
      acceptance_criteria: ["users can complete the full dashboard flow", "UI clearly shows success and validation states"],
      definition_of_done: ["tests pass", "design review completed"],
      constraints: "Use Next.js",
      risks: [],
      delivery_target: "web-ui",
    };

    const drafts = buildDecompositionChildDrafts(spec, 7, "large");

    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.scopeItems).toHaveLength(2);
    expect(drafts[1]?.scopeItems).toHaveLength(2);
    expect(drafts[0]?.title).toBe("Dashboard UX Refresh — Frontend & UX");
    expect(drafts[1]?.title).toBe("Dashboard UX Refresh — Frontend & UX 2");
  });
});
