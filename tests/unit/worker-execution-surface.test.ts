import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW } from "../../lib/workflow/index.js";

const {
  mockAuditLog,
  mockReadProjects,
  mockLoadConfig,
  mockCreateProvider,
  mockExecuteCompletion,
  mockUpdateIssueRuntime,
  mockRecordIssueLifecycle,
} = vi.hoisted(() => ({
  mockAuditLog: vi.fn(),
  mockReadProjects: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockCreateProvider: vi.fn(),
  mockExecuteCompletion: vi.fn(),
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

describe("worker execution surface", () => {
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
          },
          issueRuntime: {
            "7": {
              lastDispatchCycleId: "cycle-1",
              dispatchRunId: "run-1",
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

    mockExecuteCompletion.mockResolvedValue(undefined);
    mockUpdateIssueRuntime.mockResolvedValue(undefined);
    mockRecordIssueLifecycle.mockResolvedValue(true);
    mockAuditLog.mockResolvedValue(undefined);
  });

  it("classifies meta-skills in assistant transcript as invalid execution paths", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I should use brainstorming before changing behavior.\nThen I can load writing-plans and continue.",
          },
        ],
      }],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
    });

    expect(result).toMatchObject({ applied: false, reason: "invalid_execution_path" });
    expect(mockUpdateIssueRuntime).toHaveBeenCalledWith(
      "/tmp/ws",
      "demo",
      7,
      expect.objectContaining({
        inconclusiveCompletionReason: "invalid_execution_path",
      }),
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/ws",
      "worker_completion_inconclusive",
      expect.objectContaining({
        reason: "invalid_execution_path",
        violationReason: "meta_skill",
        evidence: expect.stringContaining("brainstorming"),
      }),
    );
  });

  it("classifies explicit nested delegation language as an invalid execution path", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I'll spawn a coding agent to handle this task and wait for it to finish.",
          },
        ],
      }],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
    });

    expect(result).toMatchObject({ applied: false, reason: "invalid_execution_path" });
    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/ws",
      "worker_completion_inconclusive",
      expect.objectContaining({
        reason: "invalid_execution_path",
        violationReason: "nested_coding_agent",
        evidence: expect.stringContaining("spawn a coding agent"),
      }),
    );
  });

  it("detects grounded coding-agent transcript evidence from session history", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
      runtime: {
        subagent: {
          getSessionMessages: vi.fn().mockResolvedValue({
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "thinking",
                    thinking: "I need to read exactly one skill that focuses on coding-agent to get this right.",
                  },
                ],
              },
              {
                role: "toolResult",
                content: [
                  {
                    type: "text",
                    text: "bash pty:true workdir:~/project background:true command:\"codex exec --full-auto 'Build a snake game'\"",
                  },
                ],
              },
            ],
          }),
        },
      } as never,
    });

    expect(result).toMatchObject({ applied: false, reason: "invalid_execution_path" });
    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/ws",
      "worker_completion_inconclusive",
      expect.objectContaining({
        reason: "invalid_execution_path",
        violationReason: "nested_coding_agent",
        evidence: expect.stringMatching(/coding-agent|codex exec --full-auto/),
      }),
    );
  });

  it("leaves ordinary direct-execution text on the existing missing-result path", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I inspected the repo, updated the worker completion path directly, and ran focused tests.",
          },
        ],
      }],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
    });

    expect(result).toMatchObject({ applied: false, reason: "inconclusive_completion" });
    expect(mockUpdateIssueRuntime).toHaveBeenCalledWith(
      "/tmp/ws",
      "demo",
      7,
      expect.objectContaining({
        inconclusiveCompletionReason: "missing_result_line",
      }),
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/ws",
      "worker_completion_inconclusive",
      expect.objectContaining({
        reason: "missing_result_line",
      }),
    );
    expect(mockAuditLog).not.toHaveBeenCalledWith(
      "/tmp/ws",
      "worker_completion_inconclusive",
      expect.objectContaining({
        reason: "invalid_execution_path",
      }),
    );
  });
});
