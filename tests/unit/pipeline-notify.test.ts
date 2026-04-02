import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW } from "../../lib/workflow/index.js";

const {
  mockNotify,
  mockGetNotificationConfig,
  mockLoadConfig,
  mockLoadProjectBySlug,
  mockDeactivateWorker,
  mockUpdateIssueRuntime,
  mockClearIssueRuntime,
  mockAuditLog,
} = vi.hoisted(() => ({
  mockNotify: vi.fn().mockResolvedValue(true),
  mockGetNotificationConfig: vi.fn().mockReturnValue({}),
  mockLoadConfig: vi.fn(),
  mockLoadProjectBySlug: vi.fn(),
  mockDeactivateWorker: vi.fn().mockResolvedValue(undefined),
  mockUpdateIssueRuntime: vi.fn().mockResolvedValue(undefined),
  mockClearIssueRuntime: vi.fn().mockResolvedValue(undefined),
  mockAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/dispatch/notify.js", () => ({
  notify: mockNotify,
  getNotificationConfig: mockGetNotificationConfig,
}));

vi.mock("../../lib/projects/index.js", () => ({
  deactivateWorker: mockDeactivateWorker,
  loadProjectBySlug: mockLoadProjectBySlug,
  getRoleWorker: vi.fn((project: any, role: string) => project.workers[role]),
  getIssueRuntime: vi.fn((project: any, issueId: number) => project.issueRuntime?.[String(issueId)]),
  clearIssueRuntime: mockClearIssueRuntime,
  updateIssueRuntime: mockUpdateIssueRuntime,
}));

vi.mock("../../lib/config/index.js", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("../../lib/audit.js", () => ({
  log: mockAuditLog,
}));

describe("executeCompletion notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockLoadConfig.mockResolvedValue({
      workflow: DEFAULT_WORKFLOW,
      timeouts: { autoGitPullAfterMerge: false },
    });

    mockLoadProjectBySlug.mockResolvedValue({
      slug: "demo",
      name: "todo-summary",
      repo: "org/repo",
      channels: [{ channel: "telegram", channelId: "ops-room", events: ["*"] }],
      workers: {
        developer: {
          levels: {
            medior: [{ name: "Brittne" }],
          },
        },
      },
      issueRuntime: {},
    });
  });

  it("passes runCommand through worker completion notifications when runtime transport is unavailable", async () => {
    const { executeCompletion } = await import("../../lib/services/pipeline.js");
    const runCommand = vi.fn();
    const provider = {
      transitionLabel: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue({
        iid: 7,
        title: "todo-summary-cli",
        web_url: "https://example.com/issues/7",
        labels: ["To Review", "review:agent"],
        state: "opened",
      }),
      getPrStatus: vi.fn().mockResolvedValue({}),
    };

    await executeCompletion({
      workspaceDir: "/tmp/ws",
      projectSlug: "demo",
      role: "developer",
      result: "done",
      issueId: 7,
      provider: provider as never,
      repoPath: "/tmp/org-repo",
      projectName: "todo-summary",
      channels: [{ channel: "telegram", channelId: "ops-room", events: ["*"] }] as never,
      runCommand: runCommand as never,
      level: "medior",
      slotIndex: 0,
    });

    expect(mockNotify).toHaveBeenCalled();
    for (const call of mockNotify.mock.calls) {
      expect(call[1]).toEqual(
        expect.objectContaining({
          runCommand,
        }),
      );
    }
  });
});
