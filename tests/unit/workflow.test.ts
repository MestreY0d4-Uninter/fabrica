/**
 * Unit tests for the workflow FSM — validates all state transitions.
 *
 * These tests verify that:
 * - All states exist and have correct types
 * - All transitions produce correct completion rules
 * - Query functions return correct labels
 * - Feedback state detection works
 * - Review/test phase detection works
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_WORKFLOW } from "../../lib/workflow/defaults.js";
import {
  StateType,
  WorkflowEvent,
  Action,
  ReviewCheck,
} from "../../lib/workflow/types.js";
import {
  getStateLabels,
  getCurrentStateLabel,
  getInitialStateLabel,
  getQueueLabels,
  getActiveLabel,
  getRevertLabel,
  detectRoleFromLabel,
  findStateByLabel,
  findStateKeyByLabel,
  hasWorkflowStates,
  isFeedbackState,
  hasReviewCheck,
  producesReviewableWork,
  hasTestPhase,
} from "../../lib/workflow/queries.js";
import {
  getCompletionRule,
  getNextStateDescription,
  getCompletionEmoji,
} from "../../lib/workflow/completion.js";
import {
  resolveReviewRouting,
  resolveTestRouting,
  resolveNotifyChannel,
  detectOwner,
  isOwnedByOrUnclaimed,
  getOwnerLabel,
  getRoleLabels,
  OPERATIONAL_LABELS,
} from "../../lib/workflow/labels.js";

const W = DEFAULT_WORKFLOW;

// ---------------------------------------------------------------------------
// State existence and types
// ---------------------------------------------------------------------------

describe("DEFAULT_WORKFLOW states", () => {
  it("has all expected states", () => {
    const keys = Object.keys(W.states);
    expect(keys).toContain("planning");
    expect(keys).toContain("todo");
    expect(keys).toContain("doing");
    expect(keys).toContain("toReview");
    expect(keys).toContain("reviewing");
    expect(keys).toContain("toTest");
    expect(keys).toContain("testing");
    expect(keys).toContain("done");
    expect(keys).toContain("rejected");
    expect(keys).toContain("toImprove");
    expect(keys).toContain("refining");
    expect(keys).toContain("toResearch");
    expect(keys).toContain("researching");
  });

  it("has correct state types", () => {
    expect(W.states.planning.type).toBe(StateType.HOLD);
    expect(W.states.todo.type).toBe(StateType.QUEUE);
    expect(W.states.doing.type).toBe(StateType.ACTIVE);
    expect(W.states.toReview.type).toBe(StateType.QUEUE);
    expect(W.states.reviewing.type).toBe(StateType.ACTIVE);
    expect(W.states.toTest.type).toBe(StateType.QUEUE);
    expect(W.states.testing.type).toBe(StateType.ACTIVE);
    expect(W.states.done.type).toBe(StateType.TERMINAL);
    expect(W.states.rejected.type).toBe(StateType.TERMINAL);
    expect(W.states.toImprove.type).toBe(StateType.QUEUE);
    expect(W.states.refining.type).toBe(StateType.HOLD);
    expect(W.states.toResearch.type).toBe(StateType.QUEUE);
    expect(W.states.researching.type).toBe(StateType.ACTIVE);
  });

  it("has correct role assignments", () => {
    expect(W.states.todo.role).toBe("developer");
    expect(W.states.doing.role).toBe("developer");
    expect(W.states.toReview.role).toBe("reviewer");
    expect(W.states.reviewing.role).toBe("reviewer");
    expect(W.states.toTest.role).toBe("tester");
    expect(W.states.testing.role).toBe("tester");
    expect(W.states.toImprove.role).toBe("developer");
    expect(W.states.toResearch.role).toBe("architect");
    expect(W.states.researching.role).toBe("architect");
  });

  it("initial state is planning", () => {
    expect(W.initial).toBe("planning");
  });

  it("review policy defaults to human", () => {
    expect(W.reviewPolicy).toBe("human");
  });

  it("test policy defaults to skip", () => {
    expect(W.testPolicy).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

describe("workflow queries", () => {
  it("getStateLabels returns all labels", () => {
    const labels = getStateLabels(W);
    expect(labels).toContain("Planning");
    expect(labels).toContain("To Do");
    expect(labels).toContain("Doing");
    expect(labels).toContain("To Review");
    expect(labels).toContain("Done");
    expect(labels.length).toBe(Object.keys(W.states).length);
  });

  it("getCurrentStateLabel finds the right state", () => {
    expect(getCurrentStateLabel(["To Do", "bug"], W)).toBe("To Do");
    expect(getCurrentStateLabel(["feature", "Doing"], W)).toBe("Doing");
    expect(getCurrentStateLabel(["feature", "bug"], W)).toBeNull();
  });

  it("getInitialStateLabel returns Planning", () => {
    expect(getInitialStateLabel(W)).toBe("Planning");
  });

  it("getQueueLabels returns role queues by priority", () => {
    const devQueues = getQueueLabels(W, "developer");
    expect(devQueues).toContain("To Do");
    expect(devQueues).toContain("To Improve");
    // To Improve has higher priority (3) than To Do (1)
    expect(devQueues.indexOf("To Improve")).toBeLessThan(devQueues.indexOf("To Do"));
  });

  it("getActiveLabel returns correct labels", () => {
    expect(getActiveLabel(W, "developer")).toBe("Doing");
    expect(getActiveLabel(W, "reviewer")).toBe("Reviewing");
    expect(getActiveLabel(W, "tester")).toBe("Testing");
    expect(getActiveLabel(W, "architect")).toBe("Researching");
  });

  it("getActiveLabel throws for unknown role", () => {
    expect(() => getActiveLabel(W, "unknown")).toThrow();
  });

  it("detectRoleFromLabel detects roles from queue labels", () => {
    expect(detectRoleFromLabel(W, "To Do")).toBe("developer");
    expect(detectRoleFromLabel(W, "To Review")).toBe("reviewer");
    expect(detectRoleFromLabel(W, "To Test")).toBe("tester");
    expect(detectRoleFromLabel(W, "To Research")).toBe("architect");
    expect(detectRoleFromLabel(W, "Doing")).toBeNull(); // active, not queue
  });

  it("findStateByLabel finds correct state config", () => {
    const todo = findStateByLabel(W, "To Do");
    expect(todo).not.toBeNull();
    expect(todo!.role).toBe("developer");
    expect(todo!.type).toBe(StateType.QUEUE);
  });

  it("hasWorkflowStates checks role existence", () => {
    expect(hasWorkflowStates(W, "developer")).toBe(true);
    expect(hasWorkflowStates(W, "reviewer")).toBe(true);
    expect(hasWorkflowStates(W, "tester")).toBe(true);
    expect(hasWorkflowStates(W, "architect")).toBe(true);
    expect(hasWorkflowStates(W, "nonexistent")).toBe(false);
  });

  it("isFeedbackState detects feedback states", () => {
    expect(isFeedbackState(W, "To Improve")).toBe(true);
    // Refining is a HOLD state (via BLOCKED), not a feedback state (via REJECT/FAIL/etc.)
    expect(isFeedbackState(W, "Refining")).toBe(false);
    expect(isFeedbackState(W, "To Do")).toBe(false);
    expect(isFeedbackState(W, "Doing")).toBe(false);
    // Rejected is reached via PR_CLOSED which is a feedback event
    expect(isFeedbackState(W, "Rejected")).toBe(true);
  });

  it("hasReviewCheck detects reviewer check states", () => {
    expect(hasReviewCheck(W, "reviewer")).toBe(true);
    expect(hasReviewCheck(W, "developer")).toBe(false);
    expect(hasReviewCheck(W, "tester")).toBe(false);
  });

  it("producesReviewableWork checks developer output", () => {
    expect(producesReviewableWork(W, "developer")).toBe(true);
    expect(producesReviewableWork(W, "reviewer")).toBe(false);
    expect(producesReviewableWork(W, "tester")).toBe(false);
  });

  it("hasTestPhase returns true for default workflow", () => {
    expect(hasTestPhase(W)).toBe(true);
  });

  it("getRevertLabel returns correct labels", () => {
    expect(getRevertLabel(W, "developer")).toBe("To Do");
    expect(getRevertLabel(W, "reviewer")).toBe("To Review");
    expect(getRevertLabel(W, "tester")).toBe("To Test");
  });
});

// ---------------------------------------------------------------------------
// Completion rules
// ---------------------------------------------------------------------------

describe("completion rules", () => {
  it("developer done → toReview", () => {
    const rule = getCompletionRule(W, "developer", "done");
    expect(rule).not.toBeNull();
    expect(rule!.from).toBe("Doing");
    expect(rule!.to).toBe("To Review");
    expect(rule!.actions).toContain(Action.DETECT_PR);
  });

  it("developer blocked → refining", () => {
    const rule = getCompletionRule(W, "developer", "blocked");
    expect(rule).not.toBeNull();
    expect(rule!.to).toBe("Refining");
    expect(rule!.actions).toEqual([]);
  });

  it("reviewer approve → toTest without merge", () => {
    const rule = getCompletionRule(W, "reviewer", "approve");
    expect(rule).not.toBeNull();
    expect(rule!.from).toBe("Reviewing");
    expect(rule!.to).toBe("To Test");
    expect(rule!.actions).toEqual([]);
  });

  it("reviewer reject → toImprove", () => {
    const rule = getCompletionRule(W, "reviewer", "reject");
    expect(rule).not.toBeNull();
    expect(rule!.to).toBe("To Improve");
    expect(rule!.actions).toEqual([]);
  });

  it("tester pass → done with merge and close", () => {
    const rule = getCompletionRule(W, "tester", "pass");
    expect(rule).not.toBeNull();
    expect(rule!.to).toBe("Done");
    expect(rule!.actions).toContain(Action.MERGE_PR);
    expect(rule!.actions).toContain(Action.GIT_PULL);
    expect(rule!.actions).toContain(Action.CLOSE_ISSUE);
  });

  it("tester fail → toImprove with reopen", () => {
    const rule = getCompletionRule(W, "tester", "fail");
    expect(rule).not.toBeNull();
    expect(rule!.to).toBe("To Improve");
    expect(rule!.actions).toContain(Action.REOPEN_ISSUE);
  });

  it("architect done → done with close", () => {
    const rule = getCompletionRule(W, "architect", "done");
    expect(rule).not.toBeNull();
    expect(rule!.to).toBe("Done");
    expect(rule!.actions).toContain(Action.CLOSE_ISSUE);
  });

  it("unknown result returns null", () => {
    expect(getCompletionRule(W, "developer", "unknown")).toBeNull();
  });

  it("unknown role returns null", () => {
    expect(getCompletionRule(W, "unknown", "done")).toBeNull();
  });

  it("getNextStateDescription returns human-readable descriptions", () => {
    expect(getNextStateDescription(W, "developer", "done")).toBe("REVIEWER queue");
    expect(getNextStateDescription(W, "tester", "pass")).toBe("Done!");
    expect(getNextStateDescription(W, "developer", "blocked")).toBe("awaiting human decision");
  });

  it("getCompletionEmoji returns correct emoji", () => {
    expect(getCompletionEmoji("developer", "done")).toBe("✅");
    expect(getCompletionEmoji("tester", "pass")).toBe("🎉");
    expect(getCompletionEmoji("tester", "fail")).toBe("❌");
    expect(getCompletionEmoji("developer", "blocked")).toBe("🚫");
  });
});

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

describe("label helpers", () => {
  it("resolveReviewRouting", () => {
    expect(resolveReviewRouting("human", "medior")).toBe("review:human");
    expect(resolveReviewRouting("agent", "medior")).toBe("review:agent");
    expect(resolveReviewRouting("skip", "medior")).toBe("review:skip");
  });

  it("resolveTestRouting", () => {
    expect(resolveTestRouting("agent", "medior")).toBe("test:agent");
    expect(resolveTestRouting("skip", "medior")).toBe("test:skip");
  });

  it("resolveNotifyChannel falls back to first channel", () => {
    const channels = [
      { channelId: "ch1", channel: "telegram", name: "primary" },
      { channelId: "ch2", channel: "discord", name: "dev" },
    ];
    expect(resolveNotifyChannel([], channels)?.channelId).toBe("ch1");
  });

  it("resolveNotifyChannel respects notify: label", () => {
    const channels = [
      { channelId: "ch1", channel: "telegram", name: "primary" },
      { channelId: "ch2", channel: "discord", name: "dev" },
    ];
    const result = resolveNotifyChannel(["notify:discord:dev"], channels);
    expect(result?.channelId).toBe("ch2");
  });

  it("resolveNotifyChannel returns undefined for an invalid notify: label instead of falling back silently", () => {
    const channels = [
      { channelId: "ch1", channel: "telegram", name: "primary" },
      { channelId: "ch2", channel: "discord", name: "dev" },
    ];
    expect(resolveNotifyChannel(["notify:discord:missing"], channels)).toBeUndefined();
  });

  it("owner labels", () => {
    expect(getOwnerLabel("Samaria")).toBe("owner:Samaria");
    expect(detectOwner(["owner:Samaria", "To Do"])).toBe("Samaria");
    expect(detectOwner(["To Do"])).toBeNull();
    expect(isOwnedByOrUnclaimed(["To Do"], "Samaria")).toBe(true);
    expect(isOwnedByOrUnclaimed(["owner:Samaria"], "Samaria")).toBe(true);
    expect(isOwnedByOrUnclaimed(["owner:Other"], "Samaria")).toBe(false);
  });

  it("getRoleLabels generates labels for all roles", () => {
    const roles = {
      developer: { levels: ["junior", "medior", "senior"] },
      reviewer: { levels: ["junior", "senior"] },
      tester: { levels: ["junior", "medior", "senior"] },
    };
    const labels = getRoleLabels(roles);
    const names = labels.map((l) => l.name);
    expect(names).toContain("developer:junior");
    expect(names).toContain("developer:medior");
    expect(names).toContain("developer:senior");
    expect(names).toContain("reviewer:junior");
    expect(names).toContain("reviewer:senior");
    expect(names).toContain("review:human");
    expect(names).toContain("review:agent");
    expect(names).toContain("review:skip");
    expect(names).toContain("test:skip");
  });

  it("includes decomposition labels in managed operational labels", () => {
    const names = OPERATIONAL_LABELS.map((label) => label.name);
    expect(names).toContain("decomposition:parent");
    expect(names).toContain("decomposition:child");
  });
});

// ---------------------------------------------------------------------------
// Full pipeline transitions
// ---------------------------------------------------------------------------

describe("full happy path transitions", () => {
  it("planning → todo → doing → toReview → reviewing → toTest → done", () => {
    // planning → todo (APPROVE)
    const planningTarget = W.states.planning.on?.[WorkflowEvent.APPROVE];
    expect(planningTarget).toBe("todo");

    // todo → doing (PICKUP)
    const todoTarget = W.states.todo.on?.[WorkflowEvent.PICKUP];
    expect(todoTarget).toBe("doing");

    // doing → toReview (COMPLETE)
    const doingTarget = W.states.doing.on?.[WorkflowEvent.COMPLETE];
    expect(typeof doingTarget === "object" && doingTarget.target).toBe("toReview");

    // toReview → reviewing (PICKUP)
    const toReviewPickup = W.states.toReview.on?.[WorkflowEvent.PICKUP];
    expect(toReviewPickup).toBe("reviewing");

    // reviewing → toTest (APPROVE with merge)
    const reviewApprove = W.states.reviewing.on?.[WorkflowEvent.APPROVE];
    expect(typeof reviewApprove === "object" && reviewApprove.target).toBe("toTest");

    // toTest → done (SKIP with close)
    const testSkip = W.states.toTest.on?.[WorkflowEvent.SKIP];
    expect(typeof testSkip === "object" && testSkip.target).toBe("done");
  });

  it("reject loop: reviewing → toImprove → doing", () => {
    const reject = W.states.reviewing.on?.[WorkflowEvent.REJECT];
    expect(reject).toBe("toImprove");

    const pickup = W.states.toImprove.on?.[WorkflowEvent.PICKUP];
    expect(pickup).toBe("doing");
  });

  it("test fail loop: testing → toImprove → doing", () => {
    const fail = W.states.testing.on?.[WorkflowEvent.FAIL];
    expect(typeof fail === "object" && fail.target).toBe("toImprove");

    const pickup = W.states.toImprove.on?.[WorkflowEvent.PICKUP];
    expect(pickup).toBe("doing");
  });

  it("refining escape: refining → todo", () => {
    const approve = W.states.refining.on?.[WorkflowEvent.APPROVE];
    expect(approve).toBe("todo");
  });

  it("architect pipeline: toResearch → researching → done", () => {
    const pickup = W.states.toResearch.on?.[WorkflowEvent.PICKUP];
    expect(pickup).toBe("researching");

    const complete = W.states.researching.on?.[WorkflowEvent.COMPLETE];
    expect(typeof complete === "object" && complete.target).toBe("done");
  });
});
