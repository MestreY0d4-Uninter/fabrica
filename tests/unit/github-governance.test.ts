import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncGitHubMergeGovernance } from "../../lib/github/governance.js";

const request = vi.fn();

vi.mock("../../lib/github/app-auth.js", () => ({
  getGitHubRepoInstallationOctokit: vi.fn(async () => ({
    installationId: 77,
    octokit: { request },
  })),
}));

describe("syncGitHubMergeGovernance", () => {
  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue({ data: {} });
  });

  it("configures branch protection with Fabrica as the required check", async () => {
    const result = await syncGitHubMergeGovernance({
      pluginConfig: {},
      owner: "acme",
      repo: "demo",
      branch: "main",
      requiredApprovingReviewCount: 2,
      requireConversationResolution: true,
      enableAutomerge: true,
      enableMergeQueue: true,
    });

    expect(result).toEqual({
      attempted: true,
      requiredCheckConfigured: true,
      automergePrepared: true,
      mergeQueuePrepared: true,
      installationId: 77,
    });
    expect(request).toHaveBeenCalledWith(
      "PUT /repos/{owner}/{repo}/branches/{branch}/protection",
      expect.objectContaining({
        owner: "acme",
        repo: "demo",
        branch: "main",
        required_status_checks: expect.objectContaining({
          contexts: ["Fabrica / Quality Gate"],
        }),
        required_pull_request_reviews: expect.objectContaining({
          required_approving_review_count: 2,
        }),
        required_conversation_resolution: true,
      }),
    );
    expect(request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}",
      expect.objectContaining({
        owner: "acme",
        repo: "demo",
        allow_auto_merge: true,
      }),
    );
  });
});
