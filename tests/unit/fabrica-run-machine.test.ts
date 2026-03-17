import { describe, expect, it } from "vitest";
import { transition } from "xstate";
import { fabricaRunMachine, type FabricaRunMachineContext } from "../../lib/machines/FabricaRunMachine.js";
import { transitionFabricaRun } from "../../lib/machines/fabrica-run-runner.js";

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

describe("FabricaRunMachine", () => {
  it("executes the happy path from PR open to merged pass", () => {
    let snapshot = fabricaRunMachine.resolveState({ value: "planned", context: baseContext() });
    [snapshot] = transition(fabricaRunMachine, snapshot, { type: "PR_OPENED", headSha: "abc123" });
    expect(snapshot.value).toBe("running");
    [snapshot] = transition(fabricaRunMachine, snapshot, { type: "REVIEW_APPROVED" });
    expect(snapshot.value).toBe("gate");
    [snapshot] = transition(fabricaRunMachine, snapshot, {
      type: "PR_MERGED",
      artifactOfRecord: {
        prNumber: 3,
        headSha: "abc123",
        mergedAt: new Date().toISOString(),
        url: "https://github.com/acme/demo/pull/3",
      },
    });
    expect(snapshot.value).toBe("passed");
    expect(snapshot.context.artifactOfRecord?.prNumber).toBe(3);
  });

  it("restarts tests on force-push and updates the head sha", () => {
    let snapshot = fabricaRunMachine.resolveState({ value: "gate", context: baseContext() });
    [snapshot] = transition(fabricaRunMachine, snapshot, { type: "FORCE_PUSH", headSha: "def456" });
    expect(snapshot.value).toBe("tests_running");
    expect(snapshot.context.headSha).toBe("def456");
  });

  it("exhausts repair attempts into failed", () => {
    let snapshot = fabricaRunMachine.resolveState({
      value: "tests_running",
      context: { ...baseContext(), repairCount: 1, maxRepairAttempts: 1 },
    });
    [snapshot] = transition(fabricaRunMachine, snapshot, { type: "TESTS_FAILED" });
    expect(snapshot.value).toBe("failed");
  });

  it("ignores invalid transitions without crashing", () => {
    const snapshot = fabricaRunMachine.resolveState({ value: "passed", context: baseContext() });
    const [next] = transition(fabricaRunMachine, snapshot, { type: "REVIEW_APPROVED" });
    expect(next.value).toBe("passed");
  });

  it("maps merged artifact into persisted passed state", () => {
    const result = transitionFabricaRun({
      run: {
        runId: "run-2",
        installationId: 1,
        repositoryId: 2,
        prNumber: 3,
        headSha: "abc123",
        issueRuntimeId: "42",
        state: "gate",
        checkRunId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      runtime: null,
      event: {
        type: "PR_MERGED",
        artifactOfRecord: {
          prNumber: 3,
          headSha: "abc123",
          mergedAt: new Date().toISOString(),
          url: "https://github.com/acme/demo/pull/3",
        },
      },
    });

    expect(result.nextState).toBe("passed");
    expect(result.run.state).toBe("passed");
    expect(result.artifactOfRecord?.prNumber).toBe(3);
  });
});
