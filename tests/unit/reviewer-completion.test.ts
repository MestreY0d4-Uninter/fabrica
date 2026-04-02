import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW } from "../../lib/workflow/index.js";

const {
  mockAuditLog,
  mockReadProjects,
  mockDeactivateWorker,
  mockLoadConfig,
  mockCreateProvider,
  mockResilientLabelTransition,
  mockNotify,
  mockGetNotificationConfig,
} = vi.hoisted(() => ({
  mockAuditLog: vi.fn(),
  mockReadProjects: vi.fn(),
  mockDeactivateWorker: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockCreateProvider: vi.fn(),
  mockResilientLabelTransition: vi.fn(),
  mockNotify: vi.fn(),
  mockGetNotificationConfig: vi.fn(),
}));

vi.mock("../../lib/audit.js", () => ({
  log: mockAuditLog,
}));

vi.mock("../../lib/projects/index.js", () => ({
  readProjects: mockReadProjects,
  deactivateWorker: mockDeactivateWorker,
  getRoleWorker: (project: any, role: string) => project.workers[role],
  getIssueRuntime: (project: any, issueId: number) => project.issueRuntime?.[String(issueId)],
}));

vi.mock("../../lib/config/index.js", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("../../lib/providers/index.js", () => ({
  createProvider: mockCreateProvider,
}));

vi.mock("../../lib/workflow/labels.js", () => ({
  resilientLabelTransition: mockResilientLabelTransition,
}));

vi.mock("../../lib/dispatch/notify.js", () => ({
  notify: mockNotify,
  getNotificationConfig: mockGetNotificationConfig,
}));

import {
  handleReviewerAgentEnd,
  resolveReviewerDecisionTransition,
} from "../../lib/services/reviewer-completion.js";

describe("reviewer-completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockReadProjects.mockResolvedValue({
      projects: {
        demo: {
          name: "demo",
          slug: "demo",
          repo: "org/repo",
          provider: "github",
          issueRuntime: {
            "7": {
              currentPrUrl: "https://example.com/pulls/17",
              dispatchRunId: "run-review-1",
              lastDispatchCycleId: "cycle-review-1",
            },
          },
          channels: [
            {
              channelId: "-100123",
              channel: "telegram",
              name: "primary",
              events: ["*"],
              accountId: "acct-1",
              messageThreadId: 42,
            },
          ],
          workers: {
            reviewer: {
              levels: {
                junior: [
                  {
                    active: true,
                    issueId: 7,
                    lastIssueId: null,
                    sessionKey: "agent:main:subagent:demo-reviewer-junior-ada",
                    startTime: "2026-03-31T12:00:00.000Z",
                    dispatchCycleId: "cycle-review-1",
                    dispatchRunId: "run-review-1",
                    previousLabel: "To Review",
                    name: "ada",
                  },
                ],
              },
            },
          },
        },
      },
    });

    mockLoadConfig.mockResolvedValue({ workflow: DEFAULT_WORKFLOW, pluginConfig: {} });
    mockCreateProvider.mockResolvedValue({
      provider: {
        getIssue: vi.fn().mockResolvedValue({ labels: ["Reviewing"], title: "Demo issue", web_url: "https://example.com/issues/7" }),
      },
    });
    mockDeactivateWorker.mockResolvedValue(undefined);
    mockResilientLabelTransition.mockResolvedValue(undefined);
    mockAuditLog.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue(true);
    mockGetNotificationConfig.mockReturnValue({});
  });

  it("maps approve to the reviewing APPROVE transition", () => {
    const result = resolveReviewerDecisionTransition(DEFAULT_WORKFLOW, "approve");

    expect(result?.eventKey).toBe("APPROVE");
    expect(result?.targetLabel).toBe("To Test");
  });

  it("maps reject to the reviewing REJECT transition", () => {
    const result = resolveReviewerDecisionTransition(DEFAULT_WORKFLOW, "reject");

    expect(result?.eventKey).toBe("REJECT");
    expect(result?.targetLabel).toBe("To Improve");
  });

  it("extracts reviewer decision from explicit agent_end messages only", async () => {
    const result = await handleReviewerAgentEnd({
      sessionKey: "agent:main:subagent:demo-reviewer-junior-ada",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Review result: APPROVE" }],
        },
      ],
    });

    expect(result).toBe("approve");
  });

  it("does not infer reviewer decisions from legacy shorthand", async () => {
    const result = await handleReviewerAgentEnd({
      sessionKey: "agent:main:subagent:demo-reviewer-junior-ada",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "LGTM" }],
        },
      ],
    });

    expect(result).toBeNull();
  });

  it("falls back to runtime session messages when agent_end messages are undecidable", async () => {
    const result = await handleReviewerAgentEnd({
      sessionKey: "agent:main:subagent:demo-reviewer-junior-ada",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Review complete." }],
        },
      ],
      runtime: {
        subagent: {
          getSessionMessages: async () => ({
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Review result: REJECT" }],
              },
            ],
          }),
        },
      },
    });

    expect(result).toBe("reject");
  });

  it("notifies the project topic when an agent reviewer rejects", async () => {
    await handleReviewerAgentEnd({
      sessionKey: "agent:main:subagent:demo-reviewer-junior-ada",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "Blocking findings",
                "",
                "1. Correctness bug: prefix detection is too permissive",
                "2. tests do not fully cover the acceptance criteria",
                "",
                "Review result: REJECT",
              ].join("\n"),
            },
          ],
        },
      ],
      workspaceDir: "/tmp/fabrica-workspace",
      runCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })) as any,
    });

    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "reviewRejected",
        project: "demo",
        issueId: 7,
        issueUrl: "https://example.com/issues/7",
        issueTitle: "Demo issue",
        prUrl: "https://example.com/pulls/17",
        summary: "Correctness bug: prefix detection is too permissive; tests do not fully cover the acceptance criteria",
        dispatchCycleId: "cycle-review-1",
        dispatchRunId: "run-review-1",
      }),
      expect.objectContaining({
        workspaceDir: "/tmp/fabrica-workspace",
        target: expect.objectContaining({
          channelId: "-100123",
          channel: "telegram",
          accountId: "acct-1",
          messageThreadId: 42,
        }),
        config: {},
      }),
    );
    expect(mockGetNotificationConfig).toHaveBeenCalledWith({});
  });
});
