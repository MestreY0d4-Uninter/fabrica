import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW } from "../../lib/workflow/index.js";

const { mockAuditLog, mockReadProjects, mockDeactivateWorker, mockLoadConfig, mockCreateProvider, mockResilientLabelTransition } = vi.hoisted(() => ({
  mockAuditLog: vi.fn(),
  mockReadProjects: vi.fn(),
  mockDeactivateWorker: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockCreateProvider: vi.fn(),
  mockResilientLabelTransition: vi.fn(),
}));

vi.mock("../../lib/audit.js", () => ({
  log: mockAuditLog,
}));

vi.mock("../../lib/projects/index.js", () => ({
  readProjects: mockReadProjects,
  deactivateWorker: mockDeactivateWorker,
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

describe("reviewer-completion side effects", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockReadProjects.mockResolvedValue({
      projects: {
        demo: {
          name: "demo",
          slug: "demo",
          repo: "org/repo",
          provider: "github",
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

    mockLoadConfig.mockResolvedValue({ workflow: DEFAULT_WORKFLOW });
    mockCreateProvider.mockResolvedValue({
      provider: {
        getIssue: vi.fn().mockResolvedValue({ labels: ["Reviewing"] }),
        transitionLabel: vi.fn(),
      },
    });
    mockDeactivateWorker.mockResolvedValue(undefined);
    mockResilientLabelTransition.mockResolvedValue(undefined);
    mockAuditLog.mockResolvedValue(undefined);
  });

  it("deactivates the reviewer slot when agent_end applies a transition", async () => {
    const { handleReviewerAgentEnd } = await import("../../lib/services/reviewer-completion.js");

    const result = await handleReviewerAgentEnd({
      sessionKey: "agent:main:subagent:demo-reviewer-junior-ada",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Review result: APPROVE" }],
        },
      ],
      workspaceDir: "/tmp/fabrica-workspace",
      runCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })) as any,
    });

    expect(result).toBe("approve");
    expect(mockResilientLabelTransition).toHaveBeenCalledWith(
      expect.anything(),
      7,
      "Reviewing",
      "To Test",
    );
    expect(mockDeactivateWorker).toHaveBeenCalledWith(
      "/tmp/fabrica-workspace",
      "demo",
      "reviewer",
      { level: "junior", slotIndex: 0 },
    );
  });
});
