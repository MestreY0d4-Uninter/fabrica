import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW } from "../../lib/workflow/index.js";

const {
  mockAuditLog,
  mockReadProjects,
  mockLoadConfig,
  mockCreateProvider,
  mockExecuteCompletion,
  mockResilientLabelTransition,
} = vi.hoisted(() => ({
  mockAuditLog: vi.fn(),
  mockReadProjects: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockCreateProvider: vi.fn(),
  mockExecuteCompletion: vi.fn(),
  mockResilientLabelTransition: vi.fn(),
}));

vi.mock("../../lib/audit.js", () => ({
  log: mockAuditLog,
}));

vi.mock("../../lib/projects/index.js", () => ({
  readProjects: mockReadProjects,
  getRoleWorker: (project: any, role: string) => project.workers[role],
  getIssueRuntime: (project: any, issueId: number) => project.issueRuntime?.[String(issueId)],
  recordIssueLifecycle: vi.fn().mockResolvedValue(true),
  resolveRepoPath: vi.fn((repo: string) => `/tmp/${repo.replace("/", "-")}`),
  updateIssueRuntime: vi.fn().mockResolvedValue(undefined),
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

  it("records skipped completion when the final result line is missing", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{ role: "assistant", content: [{ type: "text", text: "I finished the work." }] }],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
    });

    expect(result).toMatchObject({ applied: false, reason: "missing_result_line" });
    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/ws",
      "worker_result_skipped",
      expect.objectContaining({
        sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
        role: "developer",
        reason: "missing_result_line",
      }),
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
  });
});
