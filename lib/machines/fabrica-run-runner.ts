import { transition } from "xstate";
import type { IssueRuntimeState } from "../projects/types.js";
import type { FabricaRun } from "../github/types.js";
import {
  fabricaRunMachine,
  type FabricaRunArtifact,
  type FabricaRunMachineContext,
  type FabricaRunMachineEvent,
  type FabricaRunMachineState,
} from "./FabricaRunMachine.js";

export type FabricaRunTransitionResult = {
  run: FabricaRun;
  previousState: FabricaRunMachineState;
  nextState: FabricaRunMachineState;
  changed: boolean;
  artifactOfRecord: FabricaRunArtifact;
  reviewState: FabricaRunMachineContext["reviewState"];
  prState: FabricaRunMachineContext["prState"];
};

function mapPersistedState(
  state: FabricaRun["state"],
  artifactOfRecord: FabricaRunArtifact,
): FabricaRunMachineState {
  if (state === "passed" && !artifactOfRecord) return "gate";
  return state;
}

function buildContext(params: {
  run: FabricaRun;
  runtime?: IssueRuntimeState | null;
}): FabricaRunMachineContext {
  return {
    runId: params.run.runId,
    issueRuntimeId: params.run.issueRuntimeId ?? null,
    installationId: params.run.installationId,
    repositoryId: params.run.repositoryId,
    prNumber: params.run.prNumber,
    headSha: params.run.headSha,
    artifactOfRecord: params.runtime?.artifactOfRecord ?? null,
    checkRunId: params.run.checkRunId ?? null,
    repairCount: 0,
    maxRepairAttempts: 3,
    reviewState: "PENDING",
    prState: (params.runtime?.currentPrState === "merged" || params.runtime?.artifactOfRecord)
      ? "merged"
      : (params.runtime?.currentPrState === "closed" ? "closed" : "open"),
    hasConflicts: false,
  };
}

function toPersistedState(state: FabricaRunMachineState): FabricaRun["state"] {
  return state;
}

export function transitionFabricaRun(params: {
  run: FabricaRun;
  event: FabricaRunMachineEvent;
  runtime?: IssueRuntimeState | null;
  issueRuntimeId?: string | null;
  now?: string;
}): FabricaRunTransitionResult {
  const initialContext = buildContext({
    run: params.run,
    runtime: params.runtime,
  });
  const previousState = mapPersistedState(params.run.state, initialContext.artifactOfRecord);
  const snapshot = fabricaRunMachine.resolveState({
    value: previousState,
    context: initialContext,
  });
  const [nextSnapshot] = transition(fabricaRunMachine, snapshot, params.event);
  const nextState = nextSnapshot.value as FabricaRunMachineState;
  const nextContext = nextSnapshot.context;
  const changed =
    previousState !== nextState ||
    initialContext.headSha !== nextContext.headSha ||
    initialContext.artifactOfRecord !== nextContext.artifactOfRecord ||
    initialContext.reviewState !== nextContext.reviewState ||
    initialContext.prState !== nextContext.prState;

  return {
    previousState,
    nextState,
    changed,
    artifactOfRecord: nextContext.artifactOfRecord,
    reviewState: nextContext.reviewState,
    prState: nextContext.prState,
    run: {
      ...params.run,
      issueRuntimeId: params.issueRuntimeId ?? params.run.issueRuntimeId ?? null,
      headSha: nextContext.headSha,
      state: toPersistedState(nextState),
      updatedAt: params.now ?? new Date().toISOString(),
    },
  };
}
