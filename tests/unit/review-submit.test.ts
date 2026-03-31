import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockAuditLog,
  mockSubmitPrReview,
  mockGetReviewCapabilities,
  mockGetProviderIdentity,
  mockProject,
} = vi.hoisted(() => ({
  mockAuditLog: vi.fn(async () => {}),
  mockSubmitPrReview: vi.fn(),
  mockGetReviewCapabilities: vi.fn(),
  mockGetProviderIdentity: vi.fn(),
  mockProject: {
    name: "test-project",
    slug: "test-project",
    repo: "/tmp/test-repo",
    provider: "github",
    channels: [],
    workers: {},
    issueRuntime: {
      "42": {
        currentPrNumber: 77,
      },
    },
  },
}));

vi.mock("../../lib/audit.js", () => ({
  log: mockAuditLog,
}));

vi.mock("../../lib/tools/helpers.js", () => ({
  requireWorkspaceDir: () => "/tmp/workspace",
  resolveProjectFromContext: async () => ({
    project: mockProject,
    route: {
      channel: "telegram",
      channelId: "test-project",
    },
  }),
  resolveProvider: async () => ({
    provider: {
      getReviewCapabilities: mockGetReviewCapabilities,
      getProviderIdentity: mockGetProviderIdentity,
      submitPrReview: mockSubmitPrReview,
    },
    type: "github",
  }),
}));

import { createReviewSubmitTool } from "../../lib/tools/tasks/review-submit.js";

describe("review_submit tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProject.issueRuntime = {
      "42": {
        currentPrNumber: 77,
      },
    };
    mockGetReviewCapabilities.mockResolvedValue({
      formalReview: true,
      conversationComment: true,
    });
    mockGetProviderIdentity.mockResolvedValue({ mode: "github_app" });
    mockSubmitPrReview.mockResolvedValue({
      artifactId: 77,
      artifactType: "formal_review",
      prUrl: "https://github.com/org/repo/pull/77",
      usedFallback: false,
      fallbackReason: undefined,
    });
  });

  it("sanitizes sensitive content before publishing the review", async () => {
    const ctx = {
      runCommand: vi.fn(),
      runtime: {} as any,
      pluginConfig: {},
      config: {},
      logger: console,
    };
    const tool = createReviewSubmitTool(ctx as any)({ workspaceDir: "/tmp/workspace" });

    await tool.execute("1", {
      channelId: "test-project",
      issueId: 42,
      result: "reject",
      body: "Leak: /home/mateus/project token ghp_secret",
    });

    expect(mockSubmitPrReview).toHaveBeenCalledTimes(1);
    const review = mockSubmitPrReview.mock.calls[0][1];
    expect(review.body).toContain("[REDACTED_PATH]");
    expect(review.body).toContain("[REDACTED_SECRET]");
    expect(review.body).not.toContain("/home/mateus");
    expect(review.body).not.toContain("ghp_secret");
  });

  it("records artifact metadata in the audit log", async () => {
    const ctx = {
      runCommand: vi.fn(),
      runtime: {} as any,
      pluginConfig: {},
      config: {},
      logger: console,
    };
    const tool = createReviewSubmitTool(ctx as any)({ workspaceDir: "/tmp/workspace" });

    await tool.execute("1", {
      channelId: "test-project",
      issueId: 42,
      result: "approve",
      body: "Looks good.",
    });

    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/workspace",
      "review_submit",
      expect.objectContaining({
        issue: 42,
        artifactId: 77,
        artifactType: "formal_review",
        usedFallback: false,
        fallbackReason: null,
      }),
    );
  });

  it("records structured fallback reasons in the audit log and tool result", async () => {
    mockSubmitPrReview.mockResolvedValueOnce({
      artifactId: 88,
      artifactType: "pr_conversation_comment",
      prUrl: "https://github.com/org/repo/pull/77",
      usedFallback: true,
      fallbackReason: "github_app_unavailable",
    });
    const ctx = {
      runCommand: vi.fn(),
      runtime: {} as any,
      pluginConfig: {},
      config: {},
      logger: console,
    };
    const tool = createReviewSubmitTool(ctx as any)({ workspaceDir: "/tmp/workspace" });

    const result = await tool.execute("1", {
      channelId: "test-project",
      issueId: 42,
      result: "reject",
      body: "Fallback path.",
    });

    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/workspace",
      "review_submit",
      expect.objectContaining({
        artifactId: 88,
        artifactType: "pr_conversation_comment",
        usedFallback: true,
        fallbackReason: "github_app_unavailable",
      }),
    );
    expect(result).toMatchObject({
      details: expect.objectContaining({
        usedFallback: true,
        fallbackReason: "github_app_unavailable",
      }),
    });
  });

  it("fails closed when the issue has no canonical bound PR", async () => {
    mockProject.issueRuntime = {};
    const ctx = {
      runCommand: vi.fn(),
      runtime: {} as any,
      pluginConfig: {},
      config: {},
      logger: console,
    };
    const tool = createReviewSubmitTool(ctx as any)({ workspaceDir: "/tmp/workspace" });

    await expect(tool.execute("1", {
      channelId: "test-project",
      issueId: 42,
      result: "reject",
      body: "Missing binding.",
    })).rejects.toThrow(/canonical bound PR/i);

    expect(mockSubmitPrReview).not.toHaveBeenCalled();
  });

  it("rejects Fabrica reviewer sessions and points them to the canonical response contract", async () => {
    const ctx = {
      runCommand: vi.fn(),
      runtime: {} as any,
      pluginConfig: {},
      config: {},
      logger: console,
    };
    const tool = createReviewSubmitTool(ctx as any)({
      workspaceDir: "/tmp/workspace",
      sessionKey: "agent:main:subagent:test-project-reviewer-junior-ada",
    });

    await expect(tool.execute("1", {
      channelId: "test-project",
      issueId: 42,
      result: "reject",
      body: "Blocking findings.",
    })).rejects.toThrow(/Review result: APPROVE|Review result: REJECT/);

    expect(mockSubmitPrReview).not.toHaveBeenCalled();
  });

  it("rejects non-reviewer Fabrica worker sessions", async () => {
    const ctx = {
      runCommand: vi.fn(),
      runtime: {} as any,
      pluginConfig: {},
      config: {},
      logger: console,
    };
    const tool = createReviewSubmitTool(ctx as any)({
      workspaceDir: "/tmp/workspace",
      sessionKey: "agent:main:subagent:test-project-developer-senior-ada",
    });

    await expect(tool.execute("1", {
      channelId: "test-project",
      issueId: 42,
      result: "approve",
      body: "LGTM",
    })).rejects.toThrow(/must not call review_submit/i);

    expect(mockSubmitPrReview).not.toHaveBeenCalled();
  });
});
