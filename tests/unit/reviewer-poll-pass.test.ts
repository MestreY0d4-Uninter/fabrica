import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW } from "../../lib/workflow/index.js";

const {
  mockHandleReviewerAgentEnd,
  mockDeactivateWorker,
  mockReadProjects,
  mockResilientLabelTransition,
  mockAuditLog,
} = vi.hoisted(() => ({
  mockHandleReviewerAgentEnd: vi.fn(),
  mockDeactivateWorker: vi.fn(),
  mockReadProjects: vi.fn(),
  mockResilientLabelTransition: vi.fn(),
  mockAuditLog: vi.fn(),
}));

vi.mock("../../lib/services/reviewer-completion.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/services/reviewer-completion.js")>("../../lib/services/reviewer-completion.js");
  return {
    ...actual,
    handleReviewerAgentEnd: mockHandleReviewerAgentEnd,
  };
});

vi.mock("../../lib/projects/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/projects/index.js")>("../../lib/projects/index.js");
  return {
    ...actual,
    deactivateWorker: mockDeactivateWorker,
    readProjects: mockReadProjects,
  };
});

vi.mock("../../lib/workflow/labels.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/workflow/labels.js")>("../../lib/workflow/labels.js");
  return {
    ...actual,
    resilientLabelTransition: mockResilientLabelTransition,
  };
});

vi.mock("../../lib/audit.js", () => ({
  log: mockAuditLog,
}));

describe("performReviewerPollPass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditLog.mockResolvedValue(undefined);
    mockDeactivateWorker.mockResolvedValue(undefined);
    mockReadProjects.mockRejectedValue(new Error("not configured"));
    mockResilientLabelTransition.mockResolvedValue(undefined);
  });

  it("reuses the shared reviewer completion handler and reviewing APPROVE semantics", async () => {
    mockHandleReviewerAgentEnd.mockResolvedValue("approve");

    const { performReviewerPollPass } = await import("../../lib/services/heartbeat/passes.js");

    const provider = {
      getIssue: vi.fn().mockResolvedValue({ iid: 42, labels: ["Reviewing"] }),
    };

    const project = {
      name: "demo",
      workers: {
        reviewer: {
          levels: {
            junior: [
              {
                active: true,
                issueId: "42",
                sessionKey: "agent:main:subagent:demo-reviewer-junior-ada",
                startTime: new Date(Date.now() - 5 * 60_000).toISOString(),
              },
            ],
          },
        },
      },
    };

    const transitions = await performReviewerPollPass(
      "/tmp/workspace",
      "demo",
      project as any,
      provider as any,
      { workflow: DEFAULT_WORKFLOW } as any,
      {} as any,
    );

    expect(transitions).toBe(1);
    expect(mockHandleReviewerAgentEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:subagent:demo-reviewer-junior-ada",
      }),
    );
    expect(mockResilientLabelTransition).toHaveBeenCalledWith(provider, 42, "Reviewing", "To Test");
    expect(mockDeactivateWorker).toHaveBeenCalledWith("/tmp/workspace", "demo", "reviewer", {
      level: "junior",
      slotIndex: 0,
    });
    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/workspace",
      "reviewer_poll_transition",
      expect.objectContaining({
        result: "approve",
        eventKey: "APPROVE",
        from: "Reviewing",
        to: "To Test",
      }),
    );
  });

  it("releases the reviewer slot when the issue already left the active label", async () => {
    mockHandleReviewerAgentEnd.mockResolvedValue("approve");

    const { performReviewerPollPass } = await import("../../lib/services/heartbeat/passes.js");

    const provider = {
      getIssue: vi.fn().mockResolvedValue({ iid: 42, labels: ["To Test"] }),
    };

    const project = {
      name: "demo",
      workers: {
        reviewer: {
          levels: {
            junior: [
              {
                active: true,
                issueId: "42",
                sessionKey: "agent:main:subagent:demo-reviewer-junior-ada",
                startTime: new Date(Date.now() - 5 * 60_000).toISOString(),
              },
            ],
          },
        },
      },
    };

    const transitions = await performReviewerPollPass(
      "/tmp/workspace",
      "demo",
      project as any,
      provider as any,
      { workflow: DEFAULT_WORKFLOW } as any,
      {} as any,
    );

    expect(transitions).toBe(0);
    expect(mockResilientLabelTransition).not.toHaveBeenCalled();
    expect(mockDeactivateWorker).toHaveBeenCalledWith("/tmp/workspace", "demo", "reviewer", {
      level: "junior",
      slotIndex: 0,
    });
    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/workspace",
      "reviewer_poll_slot_released",
      expect.objectContaining({
        reason: "issue_already_moved",
        from: "Reviewing",
      }),
    );
  });

  it("does not let provider review polling override an active reviewer session", async () => {
    const { performReviewPass } = await import("../../lib/services/heartbeat/passes.js");

    mockReadProjects.mockResolvedValue({
      projects: {
        demo: {
          slug: "demo",
          name: "demo",
          repo: "/tmp/repo",
          groupName: "demo",
          deployUrl: "https://example.test",
          baseBranch: "main",
          deployBranch: "main",
          channels: [],
          workers: {
            reviewer: {
              levels: {
                junior: [
                  {
                    active: true,
                    issueId: "42",
                    sessionKey: "agent:main:subagent:demo-reviewer-junior-ada",
                    startTime: new Date(Date.now() - 5 * 60_000).toISOString(),
                  },
                ],
              },
            },
          },
        },
      },
    });

    const provider = {
      listIssuesByLabel: vi.fn().mockResolvedValue([
        {
          iid: 42,
          labels: ["To Review", "review:agent"],
          title: "Review authority",
          web_url: "https://example.test/issues/42",
        },
      ]),
      issueHasReaction: vi.fn().mockResolvedValue(true),
      getPrStatus: vi.fn().mockResolvedValue({
        url: "https://example.test/pull/42",
        state: "APPROVED",
        currentIssueMatch: true,
      }),
    };

    const transitions = await performReviewPass(
      "/tmp/workspace",
      "demo",
      {
        name: "demo",
        repo: "/tmp/repo",
        baseBranch: "main",
        channels: [],
      } as any,
      provider as any,
      { workflow: DEFAULT_WORKFLOW, timeouts: { gitPullMs: 30_000 } } as any,
      {},
      undefined,
      vi.fn(),
    );

    expect(transitions).toBe(0);
    expect(provider.getPrStatus).not.toHaveBeenCalled();
    expect(mockResilientLabelTransition).not.toHaveBeenCalled();
  });
});
