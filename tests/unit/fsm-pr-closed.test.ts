import { describe, it, expect } from "vitest";
import { transition } from "xstate";
import { fabricaRunMachine, type FabricaRunMachineContext } from "../../lib/machines/FabricaRunMachine.js";

function baseContext(): FabricaRunMachineContext {
  return {
    runId: "run-1",
    issueRuntimeId: "42",
    installationId: 1,
    repositoryId: 2,
    prNumber: 3,
    headSha: "abc123",
    artifactOfRecord: null,
    checkRunId: null,
    repairCount: 0,
    maxRepairAttempts: 2,
    reviewState: "PENDING",
    prState: "open",
    hasConflicts: false,
  };
}

// Test all 6 non-terminal states transition to aborted on PR_CLOSED_UNMERGED
describe("FabricaRunMachine PR_CLOSED_UNMERGED", () => {
  const nonTerminalStates = [
    "planned",
    "running",
    "waiting_review",
    "tests_running",
    "gate",
    "repairing",
  ] as const;

  for (const state of nonTerminalStates) {
    it(`transitions from ${state} to aborted on PR_CLOSED_UNMERGED`, () => {
      const snapshot = fabricaRunMachine.resolveState({ value: state, context: baseContext() });
      const [next] = transition(fabricaRunMachine, snapshot, { type: "PR_CLOSED_UNMERGED" });
      expect(next.value).toBe("aborted");
      expect(next.context.prState).toBe("aborted");
    });
  }
});
