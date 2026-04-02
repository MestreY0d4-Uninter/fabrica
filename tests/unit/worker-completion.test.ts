import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW } from "../../lib/workflow/index.js";

const {
  mockAuditLog,
  mockReadProjects,
  mockLoadConfig,
  mockCreateProvider,
  mockExecuteCompletion,
  mockResilientLabelTransition,
  mockNotify,
  mockGetNotificationConfig,
  mockDeactivateWorker,
  mockUpdateIssueRuntime,
  mockRecordIssueLifecycle,
} = vi.hoisted(() => ({
  mockAuditLog: vi.fn(),
  mockReadProjects: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockCreateProvider: vi.fn(),
  mockExecuteCompletion: vi.fn(),
  mockResilientLabelTransition: vi.fn(),
  mockNotify: vi.fn(),
  mockGetNotificationConfig: vi.fn(),
  mockDeactivateWorker: vi.fn(),
  mockUpdateIssueRuntime: vi.fn(),
  mockRecordIssueLifecycle: vi.fn(),
}));

vi.mock("../../lib/audit.js", () => ({
  log: mockAuditLog,
}));

vi.mock("../../lib/projects/index.js", () => ({
  readProjects: mockReadProjects,
  getRoleWorker: (project: any, role: string) => project.workers[role],
  getIssueRuntime: (project: any, issueId: number) => project.issueRuntime?.[String(issueId)],
  recordIssueLifecycle: mockRecordIssueLifecycle,
  resolveRepoPath: vi.fn((repo: string) => `/tmp/${repo.replace("/", "-")}`),
  updateIssueRuntime: mockUpdateIssueRuntime,
  deactivateWorker: mockDeactivateWorker,
}));

vi.mock("../../lib/config/index.js", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("../../lib/providers/index.js", () => ({
  createProvider: mockCreateProvider,
}));

vi.mock("../../lib/services/pipeline.js", () => ({
  executeCompletion: mockExecuteCompletion,
}));

vi.mock("../../lib/workflow/labels.js", () => ({
  resilientLabelTransition: mockResilientLabelTransition,
  resolveNotifyChannel: vi.fn().mockReturnValue({ channel: "telegram", channelId: "ops-room" }),
}));

vi.mock("../../lib/dispatch/notify.js", () => ({
  notify: mockNotify,
  getNotificationConfig: mockGetNotificationConfig,
}));

describe("worker-completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockReadProjects.mockResolvedValue({
      projects: {
        demo: {
          name: "todo-summary",
          slug: "demo",
          repo: "org/repo",
          provider: "github",
          channels: [],
          workers: {
            developer: {
              levels: {
                medior: [
                  {
                    active: true,
                    issueId: 7,
                    lastIssueId: null,
                    sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
                    startTime: "2026-03-31T12:00:00.000Z",
                    previousLabel: "To Do",
                    name: "brittne",
                    dispatchCycleId: "cycle-1",
                    dispatchRunId: "run-1",
                  },
                ],
              },
            },
            tester: {
              levels: {
                junior: [
                  {
                    active: true,
                    issueId: 11,
                    lastIssueId: null,
                    sessionKey: "agent:main:subagent:todo-summary-tester-junior-riley",
                    startTime: "2026-03-31T12:00:00.000Z",
                    previousLabel: "To Test",
                    name: "riley",
                    dispatchCycleId: "cycle-2",
                    dispatchRunId: "run-2",
                  },
                ],
              },
            },
          },
          issueRuntime: {
            "7": {
              lastDispatchCycleId: "cycle-1",
              dispatchRunId: "run-1",
            },
            "11": {
              lastDispatchCycleId: "cycle-2",
              dispatchRunId: "run-2",
              infraFailCount: 0,
            },
          },
        },
      },
    });

    mockLoadConfig.mockResolvedValue({
      workflow: DEFAULT_WORKFLOW,
      workflowMeta: {
        sourceLayers: [],
        hash: "test",
        normalizationFixes: [],
        keyTransitions: [],
      },
    });

    mockCreateProvider.mockResolvedValue({
      provider: {
        getIssue: vi.fn().mockResolvedValue({ labels: ["Doing"] }),
        transitionLabel: vi.fn().mockResolvedValue(undefined),
      },
    });

    mockExecuteCompletion.mockResolvedValue({
      labelTransition: "Doing -> To Review",
      announcement: "done",
      nextState: "To Review",
    });
    mockResilientLabelTransition.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue(undefined);
    mockGetNotificationConfig.mockReturnValue({});
    mockDeactivateWorker.mockResolvedValue(undefined);
    mockUpdateIssueRuntime.mockResolvedValue(undefined);
    mockRecordIssueLifecycle.mockResolvedValue(true);
    mockAuditLog.mockResolvedValue(undefined);
  });

  it("applies developer DONE only when PR validation succeeds", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const provider = {
      getIssue: vi.fn().mockResolvedValue({ labels: ["Doing"] }),
      transitionLabel: vi.fn().mockResolvedValue(undefined),
    };

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Work result: DONE" }] }],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
      providerOverride: provider as never,
      validateDeveloperDone: vi.fn().mockResolvedValue({ ok: true }),
    });

    expect(result?.applied).toBe(true);
    expect(mockExecuteCompletion).toHaveBeenCalledOnce();
    expect(mockExecuteCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        projectSlug: "demo",
        role: "developer",
        result: "done",
        issueId: 7,
        level: "medior",
        slotIndex: 0,
      }),
    );
  });

  it("records skipped completion when developer DONE lacks proof", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Work result: DONE" }] }],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
      validateDeveloperDone: vi.fn().mockResolvedValue({ ok: false, reason: "missing_pr" }),
    });

    expect(result).toMatchObject({ applied: false, reason: "missing_pr" });
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
  });

  it("records inconclusive completion when observable worker activity lacks the final result line", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{ role: "assistant", content: [{ type: "text", text: "I finished the work." }] }],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
    });

    expect(result).toMatchObject({ applied: false, reason: "inconclusive_completion" });
    expect(mockRecordIssueLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/ws",
        slug: "demo",
        issueId: 7,
        stage: "first_worker_activity",
        sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      }),
    );
    expect(mockUpdateIssueRuntime).toHaveBeenCalledWith(
      "/tmp/ws",
      "demo",
      7,
      expect.objectContaining({
        inconclusiveCompletionAt: expect.any(String),
        inconclusiveCompletionReason: "missing_result_line",
      }),
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/ws",
      "worker_completion_inconclusive",
      expect.objectContaining({
        sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
        role: "developer",
        reason: "missing_result_line",
      }),
    );
  });

  it("does not mark inconclusive activity for a stale run that no longer owns the dispatch", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      runId: "run-stale",
      messages: [{ role: "assistant", content: [{ type: "text", text: "I finished the work." }] }],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
    });

    expect(result).toMatchObject({ applied: false, reason: "stale_dispatch_cycle" });
    expect(mockRecordIssueLifecycle).not.toHaveBeenCalled();
    expect(mockUpdateIssueRuntime).not.toHaveBeenCalled();
    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/ws",
      "worker_completion_skipped",
      expect.objectContaining({
        issueId: 7,
        reason: "stale_dispatch_cycle",
      }),
    );
  });

  it("falls back to session history when agent_end payload is missing the final worker result", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const provider = {
      getIssue: vi.fn().mockResolvedValue({ labels: ["Doing"] }),
      transitionLabel: vi.fn().mockResolvedValue(undefined),
    };

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
      runtime: {
        subagent: {
          getSessionMessages: vi.fn().mockResolvedValue({
            messages: [
              { role: "assistant", content: [{ type: "text", text: "Work result: DONE" }] },
            ],
          }),
        },
      } as never,
      providerOverride: provider as never,
      validateDeveloperDone: vi.fn().mockResolvedValue({ ok: true }),
    });

    expect(result?.applied).toBe(true);
    expect(mockExecuteCompletion).toHaveBeenCalledOnce();
    expect(mockAuditLog).not.toHaveBeenCalledWith(
      "/tmp/ws",
      "worker_result_skipped",
      expect.objectContaining({ reason: "missing_result_line" }),
    );
  });

  it("applies tester FAIL_INFRA without routing through generic pipeline completion", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const provider = {
      getIssue: vi.fn().mockResolvedValue({ labels: ["Testing"] }),
      transitionLabel: vi.fn().mockResolvedValue(undefined),
    };

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-tester-junior-riley",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Test result: FAIL_INFRA" }] }],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
      providerOverride: provider as never,
    });

    expect(result).toMatchObject({ applied: true });
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
    expect(mockResilientLabelTransition).toHaveBeenCalledWith(
      provider,
      11,
      "Testing",
      "To Test",
    );
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "infraFailure",
        project: "todo-summary",
        issueId: 11,
        summary: "Infrastructure failure during testing",
        infraFailCount: 1,
      }),
      expect.any(Object),
    );
    expect(mockDeactivateWorker).toHaveBeenCalledWith(
      "/tmp/ws",
      "demo",
      "tester",
      { level: "junior", slotIndex: 0, issueId: "11" },
    );
  });

  it("routes tester REFINE through the generic completion pipeline", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const provider = {
      getIssue: vi.fn().mockResolvedValue({ labels: ["Testing"] }),
      transitionLabel: vi.fn().mockResolvedValue(undefined),
    };

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-tester-junior-riley",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Test result: REFINE" }] }],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
      providerOverride: provider as never,
    });

    expect(result).toMatchObject({ applied: true });
    expect(mockExecuteCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "tester",
        result: "refine",
        issueId: 11,
      }),
    );
  });

  it("skips agent_end completion after work_finish already marked the session completed", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    mockReadProjects.mockResolvedValueOnce({
      projects: {
        demo: {
          name: "todo-summary",
          slug: "demo",
          repo: "org/repo",
          provider: "github",
          channels: [],
          workers: {
            developer: {
              levels: {
                medior: [
                  {
                    active: false,
                    issueId: null,
                    lastIssueId: "7",
                    sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
                    startTime: null,
                    previousLabel: null,
                    name: "brittne",
                    dispatchCycleId: "cycle-1",
                    dispatchRunId: "run-1",
                  },
                ],
              },
            },
          },
          issueRuntime: {
            "7": {
              lastDispatchCycleId: "cycle-1",
              dispatchRunId: "run-1",
              dispatchRequestedAt: "2026-03-31T12:00:00.000Z",
              sessionCompletedAt: "2026-03-31T12:30:00.000Z",
              lastSessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
            },
          },
        },
      },
    });

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Work result: DONE" }] }],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
      validateDeveloperDone: vi.fn().mockResolvedValue({ ok: true }),
    });

    expect(result).toMatchObject({ applied: false, reason: "already_completed" });
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/ws",
      "worker_completion_skipped",
      expect.objectContaining({
        issueId: 7,
        reason: "already_completed",
      }),
    );
  });

  it("skips active same-cycle agent_end completion once sessionCompletedAt is already set", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    mockReadProjects.mockResolvedValueOnce({
      projects: {
        demo: {
          name: "todo-summary",
          slug: "demo",
          repo: "org/repo",
          provider: "github",
          channels: [],
          workers: {
            developer: {
              levels: {
                medior: [
                  {
                    active: true,
                    issueId: 7,
                    lastIssueId: null,
                    sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
                    startTime: "2026-04-01T12:00:00.000Z",
                    previousLabel: "To Do",
                    name: "brittne",
                    dispatchCycleId: "cycle-1",
                    dispatchRunId: "run-1",
                  },
                ],
              },
            },
          },
          issueRuntime: {
            "7": {
              lastDispatchCycleId: "cycle-1",
              dispatchRunId: "run-1",
              dispatchRequestedAt: "2026-04-01T12:00:00.000Z",
              sessionCompletedAt: "2026-04-01T12:30:00.000Z",
              lastSessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
            },
          },
        },
      },
    });

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      runId: "run-1",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Work result: DONE" }] }],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
      validateDeveloperDone: vi.fn().mockResolvedValue({ ok: true }),
    });

    expect(result).toMatchObject({ applied: false, reason: "already_completed" });
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
  });

  it("does not treat a new active dispatch cycle as already completed just because the issue has an older completion timestamp", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    mockReadProjects.mockResolvedValueOnce({
      projects: {
        demo: {
          name: "todo-summary",
          slug: "demo",
          repo: "org/repo",
          provider: "github",
          channels: [],
          workers: {
            developer: {
              levels: {
                medior: [
                  {
                    active: true,
                    issueId: 7,
                    lastIssueId: null,
                    sessionKey: "agent:main:subagent:todo-summary-developer-medior-grace",
                    startTime: "2026-04-01T12:00:00.000Z",
                    previousLabel: "To Do",
                    name: "grace",
                    dispatchCycleId: "cycle-2",
                    dispatchRunId: "run-2",
                  },
                ],
              },
            },
          },
          issueRuntime: {
            "7": {
              lastDispatchCycleId: "cycle-2",
              dispatchRunId: "run-2",
              dispatchRequestedAt: "2026-04-01T12:00:00.000Z",
              sessionCompletedAt: "2026-03-31T12:30:00.000Z",
              lastSessionKey: "agent:main:subagent:todo-summary-developer-medior-grace",
            },
          },
        },
      },
    });

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-grace",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Work result: DONE" }] }],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
      validateDeveloperDone: vi.fn().mockResolvedValue({ ok: true }),
    });

    expect(result).toMatchObject({ applied: true });
    expect(mockExecuteCompletion).toHaveBeenCalledOnce();
  });

  it("skips stale agent_end when runId does not match the current dispatch for a reused sessionKey", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    mockReadProjects.mockResolvedValueOnce({
      projects: {
        demo: {
          name: "todo-summary",
          slug: "demo",
          repo: "org/repo",
          provider: "github",
          channels: [],
          workers: {
            developer: {
              levels: {
                medior: [
                  {
                    active: true,
                    issueId: 7,
                    lastIssueId: null,
                    sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
                    startTime: "2026-04-01T12:00:00.000Z",
                    previousLabel: "To Do",
                    name: "brittne",
                    dispatchCycleId: "cycle-2",
                    dispatchRunId: "run-current",
                  },
                ],
              },
            },
          },
          issueRuntime: {
            "7": {
              lastDispatchCycleId: "cycle-2",
              dispatchRunId: "run-current",
              lastSessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
            },
          },
        },
      },
    });

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      runId: "run-stale",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Work result: DONE" }] }],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
      validateDeveloperDone: vi.fn().mockResolvedValue({ ok: true }),
    });

    expect(result).toMatchObject({ applied: false, reason: "stale_dispatch_cycle" });
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
  });
});
