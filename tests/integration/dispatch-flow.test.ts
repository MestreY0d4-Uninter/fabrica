/**
 * Integration tests for dispatch flow (M1).
 *
 * Tests the dispatch orchestration with a mock provider and gateway, validating:
 * 1. Happy path: issue in queue → session created → label transitions → agent notified
 * 2. Session failure before transition: issue stays in queue (C2 fix)
 * 3. Model downgrade: dispatch succeeds and audit records effective model
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunCommand } from "../../lib/context.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const {
  mockAuditLog,
  mockLoadConfig,
  mockResolveEffectiveModel,
  mockResolveModel,
  mockRecordWorkerState,
  mockRecordIssueLifecycle,
  mockFetchGatewaySessions,
  mockIsSessionAlive,
} = vi.hoisted(() => ({
  mockAuditLog: vi.fn(async () => {}),
  mockLoadConfig: vi.fn(),
  mockResolveEffectiveModel: vi.fn(),
  mockResolveModel: vi.fn(() => "github-copilot/claude-sonnet-4.6"),
  mockRecordWorkerState: vi.fn(async () => {}),
  mockRecordIssueLifecycle: vi.fn(async () => true),
  mockFetchGatewaySessions: vi.fn(async () => null),
  mockIsSessionAlive: vi.fn(() => true),
}));

vi.mock("../../lib/audit.js", () => ({ log: mockAuditLog }));
vi.mock("../../lib/config/index.js", () => ({ loadConfig: mockLoadConfig }));
vi.mock("../../lib/roles/index.js", () => ({ resolveModel: mockResolveModel }));
vi.mock("../../lib/roles/model-fetcher.js", () => ({
  resolveEffectiveModelForGateway: mockResolveEffectiveModel,
}));
vi.mock("../../lib/projects/index.js", () => ({
  activateWorker: vi.fn(async () => {}),
  updateSlot: vi.fn(async () => {}),
  updateIssueRuntime: vi.fn(async () => {}),
  getRoleWorker: vi.fn(() => ({ levels: {} })),
  getIssueRuntime: vi.fn(() => null),
  requireCanonicalPrSelector: vi.fn(() => ({ prNumber: 1 })),
  emptySlot: vi.fn(() => ({ sessionKey: null, issueId: null })),
  recordIssueLifecycle: mockRecordIssueLifecycle,
  resolveRepoPath: vi.fn((value: string) => value),
}));
vi.mock("../../lib/services/gateway-sessions.js", () => ({
  fetchGatewaySessions: mockFetchGatewaySessions,
  isSessionAlive: mockIsSessionAlive,
}));
vi.mock("../../lib/dispatch/notify.js", () => ({
  notify: vi.fn(async () => {}),
  getNotificationConfig: vi.fn(() => ({})),
}));
vi.mock("../../lib/dispatch/pr-context.js", () => ({
  fetchPrFeedback: vi.fn(async () => undefined),
  fetchPrContext: vi.fn(async () => undefined),
}));
vi.mock("../../lib/dispatch/attachments.js", () => ({
  formatAttachmentsForTask: vi.fn(async () => ""),
}));
vi.mock("../../lib/dispatch/bootstrap-hook.js", () => ({
  loadRoleInstructions: vi.fn(async () => ""),
}));
vi.mock("../../lib/dispatch/issue-comments.js", () => ({
  selectIssueComments: vi.fn(() => []),
}));
vi.mock("../../lib/dispatch/security-checklist.js", () => ({
  loadSecurityChecklist: vi.fn(async () => ""),
}));
vi.mock("../../lib/dispatch/message-builder.js", () => ({
  buildTaskMessage: vi.fn(() => "Task message for the agent"),
  buildConflictFixMessage: vi.fn(() => "Conflict fix message"),
  buildAnnouncement: vi.fn(() => "Dispatch announcement"),
  formatSessionLabel: vi.fn(() => "my-project-developer-junior-Alice"),
  formatSessionLabelFull: vi.fn(() => "My Project - developer - junior - Alice"),
}));
vi.mock("../../lib/dispatch/acknowledge.js", () => ({
  acknowledgeComments: vi.fn(async () => {}),
  EYES_EMOJI: "👀",
}));
vi.mock("../../lib/names.js", () => ({
  slotName: vi.fn(() => "Alice"),
}));

import { dispatchTask } from "../../lib/dispatch/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefaultConfig() {
  return {
    roles: {
      developer: {
        levels: ["junior", "medior", "senior"],
        defaultLevel: "junior",
        models: { junior: "haiku-4-5", medior: "sonnet-4.6", senior: "gpt-5.4" },
        emoji: {},
        completionResults: ["done"],
        enabled: true,
        levelMaxWorkers: { junior: 2, medior: 2, senior: 1 },
      },
    },
    workflow: {
      initial: "todo",
      states: {
        todo: { type: "queue" as const, role: "developer", label: "To Do", color: "0075ca" },
        doing: { type: "active" as const, role: "developer", label: "Doing", color: "e4e669" },
        done: { type: "terminal" as const, label: "Done", color: "0e8a16" },
      },
    },
    workflowMeta: { sourceLayers: [], hash: "abc", normalizationFixes: [], keyTransitions: {} },
    timeouts: {
      gitPullMs: 30000,
      gatewayMs: 10000,
      sessionPatchMs: 30000,
      dispatchMs: 600000,
      staleWorkerHours: 2,
      sessionContextBudget: 0.6,
      stallTimeoutMinutes: 15,
      sessionConfirmAttempts: 5,
      sessionConfirmDelayMs: 250,
      sessionLabelMaxLength: 64,
      auditLogMaxLines: 500,
      auditLogMaxBackups: 3,
      lockStaleMs: 30000,
    },
  };
}

function makeProject() {
  return {
    name: "my-project",
    slug: "my-project",
    repo: "/home/user/my-project",
    repoRemote: "https://github.com/org/my-project",
    baseBranch: "main",
    provider: "github" as const,
    channels: [{ channel: "telegram" as const, channelId: "123" }],
    workers: {
      developer: {
        levels: {
          junior: [{ sessionKey: null, issueId: null, lastIssueId: null }],
        },
      },
    },
    issues: {},
  };
}

function makeProvider(opts: { patchFails?: boolean } = {}) {
  return {
    transitionLabel: vi.fn(async () => {}),
    getIssue: vi.fn(async () => ({
      number: 42,
      title: "Test Issue",
      body: "",
      labels: ["To Do"],
      state: "open",
      web_url: "https://github.com/org/my-project/issues/42",
    })),
    addLabel: vi.fn(async () => {}),
    removeLabels: vi.fn(async () => {}),
    ensureLabel: vi.fn(async () => {}),
    reactToIssue: vi.fn(async () => {}),
    reactToPr: vi.fn(async () => {}),
    listComments: vi.fn(async () => []),
    getPrStatus: vi.fn(async () => ({ state: "open", url: "https://github.com/org/pr/1", currentIssueMatch: true })),
  };
}

function makeRunCommand(opts: { sessionPatchFails?: boolean } = {}): RunCommand {
  return vi.fn(async (args: string[]) => {
    if (args[3] === "sessions.patch") {
      if (opts.sessionPatchFails) throw new Error("gateway unavailable");
      return { stdout: "", stderr: "", exitCode: 0, code: 0, signal: null, killed: false, termination: "exit" } as any;
    }
    if (args[3] === "sessions.delete") {
      return { stdout: "", stderr: "", exitCode: 0, code: 0, signal: null, killed: false, termination: "exit" } as any;
    }
    // agent call (sendToAgent) — fire-and-forget, resolve after a tick
    return { stdout: "", stderr: "", exitCode: 0, code: 0, signal: null, killed: false, termination: "exit" } as any;
  }) as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatchTask — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue(makeDefaultConfig());
    mockResolveEffectiveModel.mockResolvedValue({
      effective: "github-copilot/claude-haiku-4-5",
      downgraded: false,
      availableModels: ["github-copilot/claude-haiku-4-5"],
    });
    mockFetchGatewaySessions.mockResolvedValue(
      new Map([["agent:unknown:subagent:my-project-developer-junior-alice", { percentUsed: 10, totalTokens: 100, contextTokens: 10 }]]),
    );
  });

  it("transitions the label and records worker state on success", async () => {
    const provider = makeProvider();
    const runCommand = makeRunCommand();

    const result = await dispatchTask({
      workspaceDir: "/tmp/workspace",
      project: makeProject() as any,
      issueId: 42,
      issueTitle: "Test Issue",
      issueDescription: "Description",
      issueUrl: "https://github.com/org/my-project/issues/42",
      role: "developer",
      level: "junior",
      fromLabel: "To Do",
      toLabel: "Doing",
      provider: provider as any,
      runCommand,
    });

    // Session should have been patched via sessions.patch BEFORE label transition
    // mock.calls entries are [args, opts] tuples, so args is at index 0
    const patchCall = (runCommand as any).mock.calls.find((c: any[]) => c[0]?.[3] === "sessions.patch");
    expect(patchCall).toBeDefined();

    // Label should have transitioned
    expect(provider.transitionLabel).toHaveBeenCalledWith(42, "To Do", "Doing");

    // Result should include dispatch info
    expect(result.sessionAction).toBe("spawn");
    expect(result.level).toBe("junior");
    expect(result.model).toBe("github-copilot/claude-haiku-4-5");
  });

  it("respects the session-before-label ordering (C2): sessions.patch is called before transitionLabel", async () => {
    const callOrder: string[] = [];
    const provider = makeProvider();
    (provider.transitionLabel as any).mockImplementation(async () => {
      callOrder.push("transitionLabel");
    });

    const runCommand: RunCommand = vi.fn(async (args: string[]) => {
      if (args[3] === "sessions.patch") callOrder.push("sessions.patch");
      return { stdout: "", stderr: "", exitCode: 0, code: 0, signal: null, killed: false, termination: "exit" } as any;
    }) as any;

    await dispatchTask({
      workspaceDir: "/tmp/workspace",
      project: makeProject() as any,
      issueId: 42,
      issueTitle: "Test Issue",
      issueDescription: "Description",
      issueUrl: "https://github.com/org/my-project/issues/42",
      role: "developer",
      level: "junior",
      fromLabel: "To Do",
      toLabel: "Doing",
      provider: provider as any,
      runCommand,
    });

    const patchIndex = callOrder.indexOf("sessions.patch");
    const transitionIndex = callOrder.indexOf("transitionLabel");
    expect(patchIndex).toBeGreaterThanOrEqual(0);
    expect(transitionIndex).toBeGreaterThan(patchIndex);
  });
});

describe("dispatchTask — session failure aborts before label transition (C2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue(makeDefaultConfig());
    mockResolveEffectiveModel.mockResolvedValue({
      effective: "github-copilot/claude-haiku-4-5",
      downgraded: false,
      availableModels: ["github-copilot/claude-haiku-4-5"],
    });
  });

  it("throws if sessions.patch fails, leaving issue in queue", async () => {
    const provider = makeProvider();
    const runCommand = makeRunCommand({ sessionPatchFails: true });

    await expect(
      dispatchTask({
        workspaceDir: "/tmp/workspace",
        project: makeProject() as any,
        issueId: 42,
        issueTitle: "Test Issue",
        issueDescription: "Description",
        issueUrl: "https://github.com/org/my-project/issues/42",
        role: "developer",
        level: "junior",
        fromLabel: "To Do",
        toLabel: "Doing",
        provider: provider as any,
        runCommand,
      }),
    ).rejects.toThrow("gateway unavailable");

    // Label must NOT have been transitioned — issue stays in queue
    expect(provider.transitionLabel).not.toHaveBeenCalled();
  });
});

describe("dispatchTask — model downgrade notification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue(makeDefaultConfig());
    mockFetchGatewaySessions.mockResolvedValue(new Map());
  });

  it("records model downgrade in audit log when effective model differs from requested", async () => {
    mockResolveEffectiveModel.mockResolvedValue({
      effective: "github-copilot/claude-haiku-4-5",
      downgraded: true,
      reason: "requested_model_unavailable",
      availableModels: ["github-copilot/claude-haiku-4-5"],
    });
    mockResolveModel.mockReturnValue("github-copilot/claude-sonnet-4.6");

    const provider = makeProvider();
    const runCommand = makeRunCommand();

    await dispatchTask({
      workspaceDir: "/tmp/workspace",
      project: makeProject() as any,
      issueId: 42,
      issueTitle: "Test Issue",
      issueDescription: "Description",
      issueUrl: "https://github.com/org/my-project/issues/42",
      role: "developer",
      level: "junior",
      fromLabel: "To Do",
      toLabel: "Doing",
      provider: provider as any,
      runCommand,
    });

    // Audit should record model_downgraded event
    const downgradedCall = mockAuditLog.mock.calls.find(
      ([, event]: [string, string]) => event === "model_downgraded",
    );
    expect(downgradedCall).toBeDefined();
    expect(downgradedCall?.[2]).toMatchObject({
      requested: "github-copilot/claude-sonnet-4.6",
      effective: "github-copilot/claude-haiku-4-5",
    });
  });
});
