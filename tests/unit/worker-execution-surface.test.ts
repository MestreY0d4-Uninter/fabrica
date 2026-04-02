import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW } from "../../lib/workflow/index.js";

const TEST_TIMEOUT_MS = 20_000;

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

  it("classifies explicit coding-agent task confessions as invalid execution paths", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "I used coding-agent to handle this task." }],
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
        violationReason: "nested_coding_agent",
        evidence: expect.stringContaining("used coding-agent to handle this task"),
      }),
    );
  }, TEST_TIMEOUT_MS);

  it("classifies coding-agent intent plus codex exec full-auto transcript evidence as invalid execution paths", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "I will use coding-agent for this issue." }],
        },
        {
          role: "toolResult",
          content: [{
            type: "text",
            text: "bash pty:true workdir:~/project background:true command:\"codex exec --full-auto 'Fix issue #7'\"",
          }],
        },
      ],
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
        evidence: expect.stringContaining("codex exec --full-auto"),
      }),
    );
  }, TEST_TIMEOUT_MS);

  it("classifies explicit delegation to Codex as an invalid execution path", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "I delegated this issue to Codex to do the work." }],
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
        evidence: expect.stringContaining("delegated this issue to codex"),
      }),
    );
  }, TEST_TIMEOUT_MS);

  it("classifies explicit Codex usage admissions as invalid execution paths", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "I used Codex to handle this task." }],
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
        evidence: expect.stringContaining("used codex to handle this task"),
      }),
    );
  }, TEST_TIMEOUT_MS);

  it("classifies explicit coding agent usage admissions as invalid execution paths", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "I used a coding agent to handle this task." }],
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
        evidence: expect.stringContaining("used a coding agent to handle this task"),
      }),
    );
  }, TEST_TIMEOUT_MS);

  it("classifies explicit progressive coding-agent launch admissions as invalid execution paths", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "I am launching a coding agent to handle this task." }],
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
        evidence: expect.stringContaining("launching a coding agent to handle this task"),
      }),
    );
  }, TEST_TIMEOUT_MS);

  it("classifies strong-evidence brainstorming usage as meta-skill execution-path violations", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "I used brainstorming to plan this task." }],
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
        violationReason: "meta_skill",
        evidence: expect.stringContaining("used brainstorming to plan this task"),
      }),
    );
  }, TEST_TIMEOUT_MS);

  it("classifies strong-evidence writing-plans usage as meta-skill execution-path violations", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "I used writing-plans to plan this issue." }],
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
        violationReason: "meta_skill",
        evidence: expect.stringContaining("used writing-plans to plan this issue"),
      }),
    );
  }, TEST_TIMEOUT_MS);

  it("treats canonical result lines as invalid when explicit forbidden execution evidence is present", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const provider = {
      getIssue: vi.fn().mockResolvedValue({ labels: ["Doing"] }),
      transitionLabel: vi.fn().mockResolvedValue(undefined),
    };

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{
        role: "assistant",
        content: [{
          type: "text",
          text: "Work result: DONE\nI used coding-agent to handle this task.",
        }],
      }],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
      providerOverride: provider as never,
      validateDeveloperDone: vi.fn().mockResolvedValue({ ok: true }),
    });

    expect(result).toMatchObject({ applied: false, reason: "invalid_execution_path" });
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
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
        violationReason: "nested_coding_agent",
      }),
    );
  }, TEST_TIMEOUT_MS);

  it("keeps ambiguous brainstorming mentions on the missing-result path", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{
        role: "assistant",
        content: [{
          type: "text",
          text: "I should use brainstorming before changing behavior.",
        }],
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
    expect(mockAuditLog).not.toHaveBeenCalledWith(
      "/tmp/ws",
      "worker_completion_inconclusive",
      expect.objectContaining({
        reason: "invalid_execution_path",
      }),
    );
  }, TEST_TIMEOUT_MS);

  it("keeps policy text and grep-style command output on the missing-result path", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Still inspecting the transcript." }],
        },
        {
          role: "toolResult",
          content: [{
            type: "text",
            text: "rg -n 'coding-agent|codex exec --full-auto' /tmp/session.jsonl",
          }],
        },
        {
          role: "toolResult",
          content: [{
            type: "text",
            text: "description: use coding-agent for larger tasks\nbash pty:true command:\"codex exec --full-auto 'Build a snake game'\"",
          }],
        },
      ],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
    });

    expect(result).toMatchObject({ applied: false, reason: "inconclusive_completion" });
    expect(mockAuditLog).not.toHaveBeenCalledWith(
      "/tmp/ws",
      "worker_completion_inconclusive",
      expect.objectContaining({
        reason: "invalid_execution_path",
      }),
    );
  }, TEST_TIMEOUT_MS);

  it("keeps self-retractions on the missing-result path", async () => {
    const { handleWorkerAgentEnd } = await import("../../lib/services/worker-completion.js");

    const result = await handleWorkerAgentEnd({
      sessionKey: "agent:main:subagent:todo-summary-developer-medior-brittne",
      messages: [{
        role: "assistant",
        content: [{
          type: "text",
          text: "I delegated this issue to Codex, but I didn't actually do it.",
        }],
      }],
      workspaceDir: "/tmp/ws",
      runCommand: vi.fn(),
    });

    expect(result).toMatchObject({ applied: false, reason: "inconclusive_completion" });
    expect(mockAuditLog).not.toHaveBeenCalledWith(
      "/tmp/ws",
      "worker_completion_inconclusive",
      expect.objectContaining({
        reason: "invalid_execution_path",
      }),
    );
  }, TEST_TIMEOUT_MS);
});
