/**
 * dispatch-atomicity.test.ts — Tests for C2 orphaned label fix.
 *
 * Verifies:
 * 1. Worker state is written before label transition (call order)
 * 2. If label transition fails after worker state write, worker is deactivated (rollback)
 * 3. Grace period: recently activated slot prevents orphan revert in scanOrphanedLabels
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// 1 & 2: dispatchTask call order and rollback
// ---------------------------------------------------------------------------

// We test indirectly by mocking the modules that dispatchTask calls.
// Track the order of key side effects to confirm write-then-label ordering.

const callOrder: string[] = [];

// --- Mock: ../projects/index.js ---
// Use importOriginal to preserve pure functions (getRoleWorker, getIssueRuntime, etc.)
// while overriding I/O functions to track call order and avoid disk access.
vi.mock("../../lib/projects/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/projects/index.js")>();
  return {
    ...actual,
    activateWorker: vi.fn(async () => {
      callOrder.push("activateWorker");
      return {};
    }),
    deactivateWorker: vi.fn(async () => {
      callOrder.push("deactivateWorker");
      return {};
    }),
    updateIssueRuntime: vi.fn(async () => {
      callOrder.push("updateIssueRuntime");
      return {};
    }),
    updateSlot: vi.fn(async () => ({})),
    recordIssueLifecycle: vi.fn(async () => {}),
    // readProjects/getProject: used by scanOrphanedLabels to re-read fresh data.
    // Return empty by default; tests that need scanOrphanedLabels pass project directly.
    readProjects: vi.fn(async () => ({ projects: {} })),
    getProject: vi.fn(() => undefined),
  };
});

// --- Mock: ../config/index.js ---
vi.mock("../../lib/config/index.js", () => ({
  loadConfig: vi.fn(async () => ({
    roles: { developer: { level: "junior" } },
    timeouts: { sessionPatchMs: 5000, dispatchMs: 30000, sessionContextBudget: 1 },
    workflow: { states: { todo: { label: "To Do" }, doing: { label: "Doing" } }, initial: "todo" },
    workflowMeta: { sourceLayers: [], hash: "test", normalizationFixes: [], keyTransitions: [] },
  })),
}));

// --- Mock: ../roles/index.js ---
vi.mock("../../lib/roles/index.js", () => ({
  resolveModel: () => "gpt-test",
}));

// --- Mock: ../roles/model-fetcher.js ---
vi.mock("../../lib/roles/model-fetcher.js", () => ({
  resolveEffectiveModelForGateway: async () => ({
    effective: "gpt-test",
    downgraded: false,
    availableModels: ["gpt-test"],
  }),
}));

// --- Mock: ../workflow/index.js ---
// Use importOriginal to preserve all real exports (needed by scanOrphanedLabels)
// while overriding resilientLabelTransition to track call order for dispatch tests.
const mockResilientLabelTransition = vi.fn(async () => {
  callOrder.push("resilientLabelTransition");
  return { success: true, dualStateResolved: false };
});

vi.mock("../../lib/workflow/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/workflow/index.js")>();
  return {
    ...actual,
    resilientLabelTransition: (...args: unknown[]) => mockResilientLabelTransition(...args),
  };
});

// --- Mock: ./pr-context.js ---
vi.mock("../../lib/dispatch/pr-context.js", () => ({
  fetchPrFeedback: async () => undefined,
  fetchPrContext: async () => undefined,
}));

// --- Mock: ./attachments.js ---
vi.mock("../../lib/dispatch/attachments.js", () => ({
  formatAttachmentsForTask: async () => undefined,
}));

// --- Mock: ./bootstrap-hook.js ---
vi.mock("../../lib/dispatch/bootstrap-hook.js", () => ({
  loadRoleInstructions: async () => "",
}));

// --- Mock: ./issue-comments.js ---
vi.mock("../../lib/dispatch/issue-comments.js", () => ({
  selectIssueComments: () => [],
}));

// --- Mock: ./security-checklist.js ---
vi.mock("../../lib/dispatch/security-checklist.js", () => ({
  loadSecurityChecklist: async () => "",
}));

// --- Mock: ./message-builder.js ---
vi.mock("../../lib/dispatch/message-builder.js", () => ({
  buildTaskMessage: () => "task message",
  buildConflictFixMessage: () => "conflict fix",
  buildAnnouncement: () => "announcement",
  formatSessionLabel: () => "test-session-label",
  formatSessionLabelFull: () => "test-session-label-full",
}));

// --- Mock: ./session.js ---
vi.mock("../../lib/dispatch/session.js", () => ({
  ensureSessionReady: vi.fn(async () => {}),
  sendToAgent: vi.fn(() => {
    callOrder.push("sendToAgent");
  }),
  shouldClearSession: async () => false,
  buildEffortPrompt: (_effort: unknown, roleInstructions: string | undefined) => roleInstructions ?? "",
}));

// --- Mock: ./acknowledge.js ---
vi.mock("../../lib/dispatch/acknowledge.js", () => ({
  acknowledgeComments: async () => {},
  EYES_EMOJI: "eyes",
}));

// --- Mock: ./notify.js ---
vi.mock("../../lib/dispatch/notify.js", () => ({
  notify: vi.fn(async () => {}),
  getNotificationConfig: () => ({}),
}));

// --- Mock: ../audit.js ---
vi.mock("../../lib/audit.js", () => ({
  log: vi.fn(async () => {}),
}));

// --- Mock: ../names.js ---
vi.mock("../../lib/names.js", () => ({
  slotName: () => "TestBot",
}));

// --- Mock: ../observability/context.js ---
vi.mock("../../lib/observability/context.js", () => ({
  withCorrelationContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// --- Mock: ../observability/telemetry.js ---
vi.mock("../../lib/observability/telemetry.js", () => ({
  withTelemetrySpan: (_name: string, _attrs: unknown, fn: () => unknown) => fn(),
}));

// Provider stub
function makeProvider() {
  return {
    getPrStatus: vi.fn(async () => ({ url: "https://example.com/pr/1", state: "OPEN", currentIssueMatch: true })),
    getIssue: vi.fn(async () => ({ labels: [], state: "open", iid: 42 })),
    transitionLabel: vi.fn(async () => {}),
    addLabel: vi.fn(async () => {}),
    removeLabels: vi.fn(async () => {}),
    ensureLabel: vi.fn(async () => {}),
    reactToIssue: vi.fn(async () => {}),
    reactToPr: vi.fn(async () => {}),
    listComments: vi.fn(async () => []),
    listIssuesByLabel: vi.fn(async () => []),
    listIssues: vi.fn(async () => []),
  } as any;
}

function makeRunCommand() {
  return vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })) as any;
}

describe("dispatch atomicity (C2 fix)", () => {
  beforeEach(() => {
    callOrder.length = 0;
    vi.clearAllMocks();
  });

  it("writes worker state before label transition", async () => {
    const { dispatchTask } = await import("../../lib/dispatch/index.js");

    await dispatchTask({
      workspaceDir: "/tmp/test-ws",
      agentId: "test-agent",
      project: {
        name: "test-project",
        slug: "test-project",
        channels: [],
        workers: { developer: { levels: { junior: [{ sessionKey: null, issueId: null, active: false, startTime: null, previousLabel: null, name: null, lastIssueId: null }] } } },
        baseBranch: "main",
      } as any,
      issueId: 42,
      issueTitle: "Test Issue",
      issueDescription: "desc",
      issueUrl: "https://github.com/test/1",
      role: "developer",
      level: "junior",
      fromLabel: "To Do",
      toLabel: "Doing",
      provider: makeProvider(),
      runCommand: makeRunCommand(),
    });

    // Verify ordering: activateWorker (worker state) must come before resilientLabelTransition
    const activateIdx = callOrder.indexOf("activateWorker");
    const labelIdx = callOrder.indexOf("resilientLabelTransition");
    const sendIdx = callOrder.indexOf("sendToAgent");

    expect(activateIdx).toBeGreaterThanOrEqual(0);
    expect(labelIdx).toBeGreaterThanOrEqual(0);
    expect(sendIdx).toBeGreaterThanOrEqual(0);

    // Write-then-label: worker state before label transition
    expect(activateIdx).toBeLessThan(labelIdx);
    // Label before send: issue committed before agent dispatch
    expect(labelIdx).toBeLessThan(sendIdx);
  });

  it("records dispatchRequestedAt after worker state write", async () => {
    const { dispatchTask } = await import("../../lib/dispatch/index.js");

    await dispatchTask({
      workspaceDir: "/tmp/test-ws",
      agentId: "test-agent",
      project: {
        name: "test-project",
        slug: "test-project",
        channels: [],
        workers: { developer: { levels: { junior: [{ sessionKey: null, issueId: null, active: false, startTime: null, previousLabel: null, name: null, lastIssueId: null }] } } },
        baseBranch: "main",
      } as any,
      issueId: 42,
      issueTitle: "Test Issue",
      issueDescription: "desc",
      issueUrl: "https://github.com/test/1",
      role: "developer",
      level: "junior",
      fromLabel: "To Do",
      toLabel: "Doing",
      provider: makeProvider(),
      runCommand: makeRunCommand(),
    });

    const activateIdx = callOrder.indexOf("activateWorker");
    const runtimeIdx = callOrder.indexOf("updateIssueRuntime");
    const labelIdx = callOrder.indexOf("resilientLabelTransition");

    expect(runtimeIdx).toBeGreaterThanOrEqual(0);
    // updateIssueRuntime after activateWorker, before label transition
    expect(activateIdx).toBeLessThan(runtimeIdx);
    expect(runtimeIdx).toBeLessThan(labelIdx);
  });

  it("rolls back worker state if label transition fails", async () => {
    const { deactivateWorker: mockDeactivate } = await import("../../lib/projects/index.js");

    // Make label transition fail
    mockResilientLabelTransition.mockRejectedValueOnce(new Error("GitHub API 422"));

    const { dispatchTask } = await import("../../lib/dispatch/index.js");

    await expect(dispatchTask({
      workspaceDir: "/tmp/test-ws",
      agentId: "test-agent",
      project: {
        name: "test-project",
        slug: "test-project",
        channels: [],
        workers: { developer: { levels: { junior: [{ sessionKey: null, issueId: null, active: false, startTime: null, previousLabel: null, name: null, lastIssueId: null }] } } },
        baseBranch: "main",
      } as any,
      issueId: 42,
      issueTitle: "Test Issue",
      issueDescription: "desc",
      issueUrl: "https://github.com/test/1",
      role: "developer",
      level: "junior",
      fromLabel: "To Do",
      toLabel: "Doing",
      provider: makeProvider(),
      runCommand: makeRunCommand(),
    })).rejects.toThrow("GitHub API 422");

    // Worker state was written first, then rolled back via deactivateWorker
    expect(callOrder).toContain("activateWorker");
    expect(callOrder).toContain("deactivateWorker");
    // sendToAgent should NOT have been called (dispatch was aborted)
    expect(callOrder).not.toContain("sendToAgent");
  });

  it("rolls back worker state if label transition returns success=false", async () => {
    mockResilientLabelTransition.mockResolvedValueOnce({ success: false, dualStateResolved: false });

    const { dispatchTask } = await import("../../lib/dispatch/index.js");

    await expect(dispatchTask({
      workspaceDir: "/tmp/test-ws",
      agentId: "test-agent",
      project: {
        name: "test-project",
        slug: "test-project",
        channels: [],
        workers: { developer: { levels: { junior: [{ sessionKey: null, issueId: null, active: false, startTime: null, previousLabel: null, name: null, lastIssueId: null }] } } },
        baseBranch: "main",
      } as any,
      issueId: 42,
      issueTitle: "Test Issue",
      issueDescription: "desc",
      issueUrl: "https://github.com/test/1",
      role: "developer",
      level: "junior",
      fromLabel: "To Do",
      toLabel: "Doing",
      provider: makeProvider(),
      runCommand: makeRunCommand(),
    })).rejects.toThrow("Label transition failed");

    expect(callOrder).toContain("activateWorker");
    expect(callOrder).toContain("deactivateWorker");
    expect(callOrder).not.toContain("sendToAgent");
  });
});

// ---------------------------------------------------------------------------
// 3: scanOrphanedLabels grace period
// ---------------------------------------------------------------------------

// For the orphan scan test, we need to use the real scanOrphanedLabels function
// with a controlled project state, so we import it separately.

describe("scanOrphanedLabels grace period", () => {
  it("skips orphan detection when a slot was recently activated", async () => {
    // We test scanOrphanedLabels directly — it reads roleWorker.levels and checks
    // if any slot has a startTime within 30 seconds.
    const { scanOrphanedLabels } = await import("../../lib/services/heartbeat/health.js");

    const recentTime = new Date(Date.now() - 5_000).toISOString(); // 5 seconds ago

    const project = {
      name: "test-project",
      slug: "test-project",
      channels: [],
      workers: {
        developer: {
          levels: {
            junior: [{
              active: true,
              issueId: "99", // Tracking issue 99, NOT 42
              sessionKey: "sk-99",
              startTime: recentTime,
              previousLabel: "To Do",
              name: "TestBot",
              lastIssueId: null,
            }],
          },
        },
      },
    } as any;

    const provider = {
      ...makeProvider(),
      listIssuesByLabel: vi.fn(async () => [
        { iid: 42, labels: ["Doing"], state: "open" }, // Issue 42 has "Doing" but is NOT tracked in any slot
      ]),
      getIssue: vi.fn(async () => ({ iid: 42, labels: ["Doing"], state: "open" })),
    };

    const workflow = {
      states: {
        todo: { label: "To Do", role: "developer", type: "queue" as const },
        doing: { label: "Doing", role: "developer", type: "active" as const },
      },
      initial: "todo",
      roles: { developer: { queue: "todo", active: "doing" } },
    } as any;

    const fixes = await scanOrphanedLabels({
      workspaceDir: "/tmp/test-ws",
      projectSlug: "test-project",
      project,
      role: "developer" as any,
      autoFix: false,
      provider,
      workflow,
    });

    // No orphan should be detected because a slot was recently activated (within 30s grace)
    expect(fixes).toHaveLength(0);
  });

  it("detects orphan when no slot was recently activated", async () => {
    const { scanOrphanedLabels } = await import("../../lib/services/heartbeat/health.js");

    const oldTime = new Date(Date.now() - 60_000).toISOString(); // 60 seconds ago (past grace period)

    const project = {
      name: "test-project",
      slug: "test-project",
      channels: [],
      workers: {
        developer: {
          levels: {
            junior: [{
              active: true,
              issueId: "99", // Tracking issue 99, NOT 42
              sessionKey: "sk-99",
              startTime: oldTime,
              previousLabel: "To Do",
              name: "TestBot",
              lastIssueId: null,
            }],
          },
        },
      },
    } as any;

    const provider = {
      ...makeProvider(),
      listIssuesByLabel: vi.fn(async () => [
        { iid: 42, labels: ["Doing"], state: "open" },
      ]),
      getIssue: vi.fn(async () => ({ iid: 42, labels: ["Doing"], state: "open" })),
    };

    const workflow = {
      states: {
        todo: { label: "To Do", role: "developer", type: "queue" as const },
        doing: { label: "Doing", role: "developer", type: "active" as const },
      },
      initial: "todo",
      roles: { developer: { queue: "todo", active: "doing" } },
    } as any;

    const fixes = await scanOrphanedLabels({
      workspaceDir: "/tmp/test-ws",
      projectSlug: "test-project",
      project,
      role: "developer" as any,
      autoFix: false,
      provider,
      workflow,
    });

    // Orphan should be detected — all slots are old (past 30s grace)
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes[0]!.issue.type).toBe("orphaned_label");
  });
});
