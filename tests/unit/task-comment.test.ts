import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAddComment,
  mockGetIssue,
} = vi.hoisted(() => ({
  mockAddComment: vi.fn(),
  mockGetIssue: vi.fn(),
}));

vi.mock("../../lib/audit.js", () => ({
  log: vi.fn(async () => {}),
}));

vi.mock("../../lib/tools/helpers.js", () => ({
  requireWorkspaceDir: () => "/tmp/workspace",
  resolveProjectFromContext: async () => ({
    project: {
      name: "test-project",
      slug: "test-project",
      repo: "/tmp/test-repo",
      provider: "github",
      channels: [],
      workers: {
        reviewer: {
          levels: {
            senior: [
              {
                active: true,
                issueId: "1",
                sessionKey: "agent:devclaw:subagent:demo-reviewer-senior-cassandre",
                startTime: "2026-03-13T00:00:00.000Z",
              },
            ],
          },
        },
      },
    },
    route: {
      channel: "telegram",
      channelId: "test-project",
    },
  }),
  resolveProvider: async () => ({
    provider: {
      addComment: mockAddComment,
      getIssue: mockGetIssue,
      reactToIssueComment: vi.fn(async () => {}),
    },
    type: "github",
  }),
  autoAssignOwnerLabel: vi.fn(async () => {}),
  applyNotifyLabel: vi.fn(() => {}),
}));

import { createTaskCommentTool } from "../../lib/tools/tasks/task-comment.js";

describe("task_comment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIssue.mockResolvedValue({
      iid: 1,
      title: "Issue",
      description: "",
      labels: [],
      state: "OPEN",
      web_url: "https://example.com/issues/1",
    });
    mockAddComment.mockResolvedValue(123);
  });

  it("blocks reviewer sessions from publishing findings on the issue", async () => {
    const tool = createTaskCommentTool({
      runCommand: vi.fn(),
      runtime: {} as any,
      pluginConfig: {},
      config: {},
      logger: console,
    } as any)({
      workspaceDir: "/tmp/workspace",
      sessionKey: "agent:devclaw:subagent:demo-reviewer-senior-cassandre",
    });

    await expect(tool.execute("1", {
      channelId: "test-project",
      issueId: 1,
      body: "Blocking findings",
    })).rejects.toThrow("review_submit");
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("rejects unsanitized public output before posting issue comments", async () => {
    const tool = createTaskCommentTool({
      runCommand: vi.fn(),
      runtime: {} as any,
      pluginConfig: {},
      config: {},
      logger: console,
    } as any)({
      workspaceDir: "/tmp/workspace",
      sessionKey: "agent:devclaw:subagent:demo-developer-senior-ada",
    });

    await expect(tool.execute("1", {
      channelId: "test-project",
      issueId: 1,
      body: "Log at /home/mateus/secret.txt with OPENAI_API_KEY=abc123",
      authorRole: "developer",
    })).rejects.toThrow("unsanitized public output");
    expect(mockAddComment).not.toHaveBeenCalled();
  });
});
