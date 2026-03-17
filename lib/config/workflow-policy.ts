import { createHash } from "node:crypto";
import type { FabricaConfig } from "./types.js";
import { Action, WorkflowEvent, type TransitionTarget, type WorkflowConfig } from "../workflow/index.js";

export type WorkflowNormalizationFix = {
  stateKey: string;
  event: string;
  removedActions: string[];
  addedActions?: string[];
  reason: "reviewer_merge_before_test" | "missing_final_merge_before_close";
};

export type WorkflowResolutionMeta = {
  sourceLayers: string[];
  hash: string;
  normalizationFixes: WorkflowNormalizationFix[];
  keyTransitions: {
    toReviewApproved: string[];
    reviewingApprove: string[];
    toReviewSkip: string[];
    toTestSkip: string[];
    testingPass: string[];
  };
};

function cloneWorkflow(workflow: WorkflowConfig): WorkflowConfig {
  return {
    ...workflow,
    states: Object.fromEntries(
      Object.entries(workflow.states).map(([key, state]) => [
        key,
        {
          ...state,
          on: state.on ? { ...state.on } : undefined,
        },
      ]),
    ),
  };
}

function transitionTarget(transition: TransitionTarget | undefined): string | null {
  if (!transition) return null;
  return typeof transition === "string" ? transition : transition.target;
}

function transitionActions(transition: TransitionTarget | undefined): string[] {
  if (!transition || typeof transition === "string") return [];
  return [...(transition.actions ?? [])];
}

function setTransitionActions(
  transition: TransitionTarget | undefined,
  actions: string[],
): TransitionTarget | undefined {
  if (!transition) return transition;
  if (typeof transition === "string") {
    return actions.length === 0 ? transition : { target: transition, actions };
  }
  return { ...transition, actions: actions.length > 0 ? actions : undefined };
}

function looksLikeTesterTarget(workflow: WorkflowConfig, targetKey: string | null): boolean {
  if (!targetKey) return false;
  const targetState = workflow.states[targetKey];
  if (targetState?.role === "tester") return true;
  const normalized = targetKey.toLowerCase();
  return normalized.includes("test");
}

export function normalizeWorkflowSemantics(workflow: WorkflowConfig): {
  workflow: WorkflowConfig;
  fixes: WorkflowNormalizationFix[];
} {
  const normalized = cloneWorkflow(workflow);
  const fixes: WorkflowNormalizationFix[] = [];
  const stripEvents = new Set<string>([
    WorkflowEvent.APPROVE,
    WorkflowEvent.APPROVED,
    WorkflowEvent.SKIP,
  ]);
  const removable = new Set<string>([
    Action.MERGE_PR,
    Action.GIT_PULL,
    Action.REOPEN_ISSUE,
  ]);

  for (const [stateKey, state] of Object.entries(normalized.states)) {
    if (state.role !== "reviewer" || !state.on) continue;

    for (const [event, transition] of Object.entries(state.on)) {
      if (!stripEvents.has(event)) continue;
      const targetKey = transitionTarget(transition);
      if (!looksLikeTesterTarget(normalized, targetKey)) continue;

      const actions = transitionActions(transition);
      const removedActions = actions.filter((action) => removable.has(action));
      if (removedActions.length === 0) continue;

      const keptActions = actions.filter((action) => !removable.has(action));
      state.on[event] = setTransitionActions(transition, keptActions)!;
      fixes.push({
        stateKey,
        event,
        removedActions,
        reason: "reviewer_merge_before_test",
      });
    }
  }

  const finalMergeRepairs: Array<{ stateKey: string; event: string }> = [
    { stateKey: "toTest", event: WorkflowEvent.SKIP },
    { stateKey: "testing", event: WorkflowEvent.PASS },
  ];

  for (const { stateKey, event } of finalMergeRepairs) {
    const state = normalized.states[stateKey];
    const transition = state?.on?.[event];
    if (!state || !transition || typeof transition === "string") continue;
    const targetState = normalized.states[transition.target];
    if (!targetState || targetState.type !== "terminal") continue;

    const actions = [...(transition.actions ?? [])];
    if (!actions.includes(Action.CLOSE_ISSUE) || actions.includes(Action.MERGE_PR)) continue;

    const mergedActions = rebuildFinalGateActions(actions);
    const addedActions = mergedActions.filter((action) => !actions.includes(action));
    state.on![event] = { ...transition, actions: mergedActions };
    fixes.push({
      stateKey,
      event,
      removedActions: [],
      addedActions,
      reason: "missing_final_merge_before_close",
    });
  }

  return { workflow: normalized, fixes };
}

function rebuildFinalGateActions(actions: string[]): string[] {
  const preserved = actions.filter((action) =>
    action !== Action.MERGE_PR &&
    action !== Action.GIT_PULL &&
    action !== Action.CLOSE_ISSUE,
  );

  return [
    Action.MERGE_PR,
    Action.GIT_PULL,
    ...preserved,
    Action.CLOSE_ISSUE,
  ];
}

export function normalizeWorkflowDocument(config: FabricaConfig): {
  config: FabricaConfig;
  fixes: WorkflowNormalizationFix[];
} {
  if (!config.workflow?.states) return { config, fixes: [] };

  const resolvedLike: WorkflowConfig = {
    initial: config.workflow.initial ?? "planning",
    reviewPolicy: config.workflow.reviewPolicy,
    testPolicy: config.workflow.testPolicy,
    roleExecution: config.workflow.roleExecution,
    maxWorkersPerLevel: config.workflow.maxWorkersPerLevel,
    states: config.workflow.states as WorkflowConfig["states"],
  };
  const { workflow, fixes } = normalizeWorkflowSemantics(resolvedLike);
  return {
    config: {
      ...config,
      workflow: {
        ...config.workflow,
        states: workflow.states,
      },
    },
    fixes,
  };
}

export function buildWorkflowResolutionMeta(
  workflow: WorkflowConfig,
  sourceLayers: string[],
  normalizationFixes: WorkflowNormalizationFix[],
): WorkflowResolutionMeta {
  const digest = createHash("sha256")
    .update(JSON.stringify(workflow))
    .digest("hex")
    .slice(0, 12);

  return {
    sourceLayers,
    hash: digest,
    normalizationFixes,
    keyTransitions: {
      toReviewApproved: transitionActions(workflow.states.toReview?.on?.[WorkflowEvent.APPROVED]),
      reviewingApprove: transitionActions(workflow.states.reviewing?.on?.[WorkflowEvent.APPROVE]),
      toReviewSkip: transitionActions(workflow.states.toReview?.on?.[WorkflowEvent.SKIP]),
      toTestSkip: transitionActions(workflow.states.toTest?.on?.[WorkflowEvent.SKIP]),
      testingPass: transitionActions(workflow.states.testing?.on?.[WorkflowEvent.PASS]),
    },
  };
}
