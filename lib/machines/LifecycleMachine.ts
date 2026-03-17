import { assign, setup } from "xstate";

export type LifecycleMachineState =
  | "booting"
  | "ready"
  | "processing.webhook"
  | "processing.heartbeat"
  | "processing.recovery"
  | "draining"
  | "error"
  | "stopped";

export type LifecycleMachineContext = {
  lastDeliveryId: string | null;
  lastRunId: string | null;
  lastIssueId: string | null;
  lastSessionKey: string | null;
  lastError: string | null;
  retryCount: number;
  updatedAt: string;
};

export type LifecycleMachineEvent =
  | { type: "BOOT_OK" }
  | { type: "BOOT_FAILED"; error?: string }
  | { type: "WEBHOOK_RECEIVED"; deliveryId?: string | null }
  | { type: "HEARTBEAT_TICK"; runId?: string | null; issueId?: string | null; sessionKey?: string | null }
  | { type: "RECOVERY_NEEDED"; runId?: string | null; issueId?: string | null; sessionKey?: string | null }
  | { type: "PROCESSING_DONE"; runId?: string | null; issueId?: string | null; sessionKey?: string | null }
  | { type: "PROCESSING_FAILED"; error?: string; runId?: string | null; issueId?: string | null; sessionKey?: string | null }
  | { type: "SHUTDOWN_SIGNAL" }
  | { type: "DRAIN_COMPLETE" }
  | { type: "ERROR_RECOVERED" }
  | { type: "ERROR_FATAL"; error?: string };

const now = () => new Date().toISOString();

const lifecycleSetup = setup({
  types: {} as {
    context: LifecycleMachineContext;
    events: LifecycleMachineEvent;
    input: Partial<LifecycleMachineContext> | undefined;
  },
  actions: {
    stamp: assign({
      updatedAt: () => now(),
      lastDeliveryId: ({ context, event }) =>
        "deliveryId" in event ? (event.deliveryId ?? context.lastDeliveryId) : context.lastDeliveryId,
      lastRunId: ({ context, event }) =>
        "runId" in event ? (event.runId ?? context.lastRunId) : context.lastRunId,
      lastIssueId: ({ context, event }) =>
        "issueId" in event ? (event.issueId ?? context.lastIssueId) : context.lastIssueId,
      lastSessionKey: ({ context, event }) =>
        "sessionKey" in event ? (event.sessionKey ?? context.lastSessionKey) : context.lastSessionKey,
    }),
    setError: assign({
      updatedAt: () => now(),
      lastError: ({ event }) =>
        "error" in event && typeof event.error === "string" ? event.error : "unknown_error",
      retryCount: ({ context }) => context.retryCount + 1,
    }),
    clearError: assign({
      updatedAt: () => now(),
      lastError: () => null,
    }),
  },
});

export const lifecycleMachine = lifecycleSetup.createMachine({
  id: "fabricaLifecycle",
  initial: "booting",
  context: ({ input }) => ({
    lastDeliveryId: input?.lastDeliveryId ?? null,
    lastRunId: input?.lastRunId ?? null,
    lastIssueId: input?.lastIssueId ?? null,
    lastSessionKey: input?.lastSessionKey ?? null,
    lastError: input?.lastError ?? null,
    retryCount: input?.retryCount ?? 0,
    updatedAt: input?.updatedAt ?? now(),
  }),
  states: {
    booting: {
      on: {
        BOOT_OK: { target: "ready", actions: ["clearError", "stamp"] },
        BOOT_FAILED: { target: "error", actions: ["setError", "stamp"] },
      },
    },
    ready: {
      on: {
        WEBHOOK_RECEIVED: { target: "processing.webhook", actions: ["stamp"] },
        HEARTBEAT_TICK: { target: "processing.heartbeat", actions: ["stamp"] },
        RECOVERY_NEEDED: { target: "processing.recovery", actions: ["stamp"] },
        SHUTDOWN_SIGNAL: { target: "draining", actions: ["stamp"] },
      },
    },
    processing: {
      initial: "webhook",
      states: {
        webhook: {},
        heartbeat: {},
        recovery: {},
      },
      on: {
        PROCESSING_DONE: { target: "ready", actions: ["clearError", "stamp"] },
        PROCESSING_FAILED: { target: "error", actions: ["setError", "stamp"] },
        SHUTDOWN_SIGNAL: { target: "draining", actions: ["stamp"] },
      },
    },
    draining: {
      on: {
        DRAIN_COMPLETE: { target: "stopped", actions: ["stamp"] },
      },
    },
    error: {
      on: {
        ERROR_RECOVERED: { target: "ready", actions: ["clearError", "stamp"] },
        ERROR_FATAL: { target: "stopped", actions: ["setError", "stamp"] },
      },
    },
    stopped: {
      type: "final",
    },
  },
});
