import { describe, expect, it } from "vitest";
import { decideBootstrapClarification, detectScopeClarificationNeed } from "../../lib/intake/lib/clarification-policy.js";

describe("decideBootstrapClarification", () => {
  it("asks for both stack and name when both are missing", () => {
    expect(decideBootstrapClarification({ projectName: null, stackHint: null })).toEqual({
      ask: true,
      kind: "stack_and_name",
      reason: "missing_stack_and_name",
    });
  });

  it("asks only for stack when project name exists", () => {
    expect(decideBootstrapClarification({ projectName: "todo-tool", stackHint: null })).toEqual({
      ask: true,
      kind: "stack",
      reason: "missing_stack",
    });
  });

  it("asks only for name when stack exists", () => {
    expect(decideBootstrapClarification({ projectName: null, stackHint: "python-cli" })).toEqual({
      ask: true,
      kind: "name",
      reason: "missing_project_name",
    });
  });

  it("does not ask when both stack and name are present", () => {
    expect(decideBootstrapClarification({ projectName: "todo-tool", stackHint: "python-cli" })).toEqual({
      ask: false,
    });
  });
});

describe("detectScopeClarificationNeed", () => {
  it("asks for scope clarification when multiple subsystems are requested without key choices", () => {
    const decision = detectScopeClarificationNeed(
      "Build an API with auth, notifications, dashboard, workers and database migrations",
      null,
    );
    expect(decision.ask).toBe(true);
    expect(decision.kind).toBe("scope");
  });

  it("skips scope clarification when the user explicitly opts out", () => {
    const decision = detectScopeClarificationNeed(
      "Build an API with auth, notifications, dashboard and workers — your call on the stack",
      null,
    );
    expect(decision).toEqual({ ask: false });
  });
});
