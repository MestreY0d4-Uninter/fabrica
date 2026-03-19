import { assign, setup } from "xstate";

export type FabricaRunArtifact = {
  prNumber: number;
  headSha?: string | null;
  mergedAt: string;
  url?: string | null;
} | null;

export type FabricaRunMachineState =
  | "planned"
  | "running"
  | "waiting_review"
  | "tests_running"
  | "gate"
  | "repairing"
  | "passed"
  | "failed"
  | "aborted";

export type FabricaRunMachineContext = {
  runId: string;
  issueRuntimeId: string | null;
  installationId: number;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  artifactOfRecord: FabricaRunArtifact;
  checkRunId: number | null;
  repairCount: number;
  maxRepairAttempts: number;
  reviewState: "PENDING" | "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  prState: "open" | "merged" | "closed" | "aborted";
  hasConflicts: boolean;
};

export type FabricaRunMachineEvent =
  | { type: "PR_OPENED"; headSha?: string }
  | { type: "PR_SYNCHRONIZED"; headSha: string }
  | { type: "PR_REOPENED"; headSha?: string }
  | { type: "PR_RETARGETED" }
  | { type: "REVIEW_APPROVED" }
  | { type: "CHANGES_REQUESTED" }
  | { type: "TESTS_PASSED" }
  | { type: "TESTS_FAILED" }
  | { type: "FORCE_PUSH"; headSha: string }
  | { type: "PR_MERGED"; artifactOfRecord: NonNullable<FabricaRunArtifact> }
  | { type: "PR_CLOSED_UNMERGED" }
  | { type: "RECOVERY_TRIGGERED" }
  | { type: "REPAIR_READY" }
  | { type: "REPAIR_EXHAUSTED" }
  | { type: "GATE_PASSED" }
  | { type: "GATE_BLOCKED" }
  | { type: "ABORT" };

const fabricaRunMachineSetup = setup({
  types: {} as {
    context: FabricaRunMachineContext;
    events: FabricaRunMachineEvent;
    input: FabricaRunMachineContext;
  },
  guards: {
    canMerge: ({ context }) =>
      context.reviewState === "APPROVED" &&
      !context.hasConflicts &&
      context.prState !== "aborted" &&
      context.prState !== "closed",
    canRepair: ({ context }) => context.repairCount < context.maxRepairAttempts,
    isHeadShaStale: ({ context, event }) =>
      ("headSha" in event) && Boolean(event.headSha) && event.headSha !== context.headSha,
  },
  actions: {
    assignHeadSha: assign({
      headSha: ({ context, event }) => ("headSha" in event && event.headSha) ? event.headSha : context.headSha,
      prState: () => "open",
      artifactOfRecord: () => null,
    }),
    incrementRepairCount: assign({
      repairCount: ({ context }) => context.repairCount + 1,
    }),
    setArtifactOfRecord: assign({
      artifactOfRecord: ({ context, event }) =>
        event.type === "PR_MERGED" ? event.artifactOfRecord : context.artifactOfRecord,
      prState: ({ context, event }) => event.type === "PR_MERGED" ? "merged" : context.prState,
    }),
    markApproved: assign({
      reviewState: () => "APPROVED",
    }),
    markChangesRequested: assign({
      reviewState: () => "CHANGES_REQUESTED",
      prState: () => "open",
    }),
    markOpen: assign({
      prState: () => "open",
    }),
    markClosed: assign({
      prState: () => "closed",
    }),
    markAborted: assign({
      prState: () => "aborted",
    }),
    clearArtifact: assign({
      artifactOfRecord: () => null,
    }),
    logTransition: () => undefined,
    emitCheckRun: () => undefined,
  },
});

export const fabricaRunMachine = fabricaRunMachineSetup.createMachine({
  id: "fabricaRun",
  initial: "planned",
  context: ({ input }) => input,
  states: {
    planned: {
      on: {
        PR_OPENED: {
          target: "running",
          actions: ["assignHeadSha", "markOpen", "emitCheckRun", "logTransition"],
        },
        PR_REOPENED: {
          target: "running",
          actions: ["assignHeadSha", "markOpen", "emitCheckRun", "logTransition"],
        },
        PR_SYNCHRONIZED: {
          target: "tests_running",
          actions: ["assignHeadSha", "markOpen", "emitCheckRun", "logTransition"],
        },
        FORCE_PUSH: {
          target: "tests_running",
          actions: ["assignHeadSha", "markOpen", "emitCheckRun", "logTransition"],
        },
        REVIEW_APPROVED: {
          target: "gate",
          actions: ["markApproved", "emitCheckRun", "logTransition"],
        },
        CHANGES_REQUESTED: {
          target: "repairing",
          actions: ["markChangesRequested", "incrementRepairCount", "emitCheckRun", "logTransition"],
        },
        PR_MERGED: {
          target: "passed",
          actions: ["setArtifactOfRecord", "emitCheckRun", "logTransition"],
        },
        PR_CLOSED_UNMERGED: {
          target: "aborted",
          actions: ["markAborted", "emitCheckRun", "logTransition"],
        },
        ABORT: {
          target: "failed",
          actions: ["markAborted", "emitCheckRun", "logTransition"],
        },
      },
    },
    running: {
      on: {
        PR_SYNCHRONIZED: {
          target: "tests_running",
          actions: ["assignHeadSha", "markOpen", "emitCheckRun", "logTransition"],
        },
        PR_REOPENED: {
          target: "running",
          actions: ["assignHeadSha", "markOpen", "emitCheckRun", "logTransition"],
        },
        FORCE_PUSH: {
          target: "tests_running",
          actions: ["assignHeadSha", "markOpen", "emitCheckRun", "logTransition"],
        },
        REVIEW_APPROVED: {
          target: "gate",
          actions: ["markApproved", "emitCheckRun", "logTransition"],
        },
        CHANGES_REQUESTED: {
          target: "repairing",
          actions: ["markChangesRequested", "incrementRepairCount", "emitCheckRun", "logTransition"],
        },
        TESTS_PASSED: {
          target: "gate",
          actions: ["emitCheckRun", "logTransition"],
        },
        TESTS_FAILED: [
          {
            guard: "canRepair",
            target: "repairing",
            actions: ["incrementRepairCount", "emitCheckRun", "logTransition"],
          },
          {
            target: "failed",
            actions: ["emitCheckRun", "logTransition"],
          },
        ],
        PR_MERGED: {
          target: "passed",
          actions: ["setArtifactOfRecord", "emitCheckRun", "logTransition"],
        },
        PR_CLOSED_UNMERGED: {
          target: "aborted",
          actions: ["markAborted", "emitCheckRun", "logTransition"],
        },
        ABORT: {
          target: "failed",
          actions: ["markAborted", "emitCheckRun", "logTransition"],
        },
      },
    },
    waiting_review: {
      on: {
        REVIEW_APPROVED: {
          target: "gate",
          actions: ["markApproved", "emitCheckRun", "logTransition"],
        },
        CHANGES_REQUESTED: {
          target: "repairing",
          actions: ["markChangesRequested", "incrementRepairCount", "emitCheckRun", "logTransition"],
        },
        FORCE_PUSH: {
          target: "tests_running",
          actions: ["assignHeadSha", "markOpen", "emitCheckRun", "logTransition"],
        },
        PR_MERGED: {
          target: "passed",
          actions: ["setArtifactOfRecord", "emitCheckRun", "logTransition"],
        },
        PR_CLOSED_UNMERGED: {
          target: "aborted",
          actions: ["markAborted", "emitCheckRun", "logTransition"],
        },
        ABORT: {
          target: "failed",
          actions: ["markAborted", "emitCheckRun", "logTransition"],
        },
      },
    },
    tests_running: {
      on: {
        TESTS_PASSED: {
          target: "gate",
          actions: ["emitCheckRun", "logTransition"],
        },
        TESTS_FAILED: [
          {
            guard: "canRepair",
            target: "repairing",
            actions: ["incrementRepairCount", "emitCheckRun", "logTransition"],
          },
          {
            target: "failed",
            actions: ["emitCheckRun", "logTransition"],
          },
        ],
        REVIEW_APPROVED: {
          target: "gate",
          actions: ["markApproved", "emitCheckRun", "logTransition"],
        },
        CHANGES_REQUESTED: {
          target: "repairing",
          actions: ["markChangesRequested", "incrementRepairCount", "emitCheckRun", "logTransition"],
        },
        FORCE_PUSH: {
          target: "tests_running",
          actions: ["assignHeadSha", "markOpen", "emitCheckRun", "logTransition"],
        },
        PR_MERGED: {
          target: "passed",
          actions: ["setArtifactOfRecord", "emitCheckRun", "logTransition"],
        },
        PR_CLOSED_UNMERGED: {
          target: "aborted",
          actions: ["markAborted", "emitCheckRun", "logTransition"],
        },
        ABORT: {
          target: "failed",
          actions: ["markAborted", "emitCheckRun", "logTransition"],
        },
      },
    },
    gate: {
      on: {
        GATE_PASSED: {
          guard: "canMerge",
          target: "passed",
          actions: ["emitCheckRun", "logTransition"],
        },
        GATE_BLOCKED: {
          target: "waiting_review",
          actions: ["emitCheckRun", "logTransition"],
        },
        CHANGES_REQUESTED: {
          target: "repairing",
          actions: ["markChangesRequested", "incrementRepairCount", "emitCheckRun", "logTransition"],
        },
        FORCE_PUSH: {
          target: "tests_running",
          actions: ["assignHeadSha", "clearArtifact", "markOpen", "emitCheckRun", "logTransition"],
        },
        PR_MERGED: {
          target: "passed",
          actions: ["setArtifactOfRecord", "emitCheckRun", "logTransition"],
        },
        PR_CLOSED_UNMERGED: {
          target: "aborted",
          actions: ["markAborted", "emitCheckRun", "logTransition"],
        },
        ABORT: {
          target: "failed",
          actions: ["markAborted", "emitCheckRun", "logTransition"],
        },
      },
    },
    repairing: {
      on: {
        REPAIR_READY: {
          target: "running",
          actions: ["markOpen", "emitCheckRun", "logTransition"],
        },
        REPAIR_EXHAUSTED: {
          target: "failed",
          actions: ["emitCheckRun", "logTransition"],
        },
        REVIEW_APPROVED: {
          target: "gate",
          actions: ["markApproved", "emitCheckRun", "logTransition"],
        },
        FORCE_PUSH: {
          target: "tests_running",
          actions: ["assignHeadSha", "markOpen", "emitCheckRun", "logTransition"],
        },
        PR_MERGED: {
          target: "passed",
          actions: ["setArtifactOfRecord", "emitCheckRun", "logTransition"],
        },
        PR_CLOSED_UNMERGED: {
          target: "aborted",
          actions: ["markAborted", "emitCheckRun", "logTransition"],
        },
        ABORT: {
          target: "failed",
          actions: ["markAborted", "emitCheckRun", "logTransition"],
        },
      },
    },
    passed: {
      type: "final",
    },
    failed: {
      type: "final",
    },
    aborted: {
      type: "final",
    },
  },
});

