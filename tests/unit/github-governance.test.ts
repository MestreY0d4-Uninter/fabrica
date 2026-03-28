import { describe, expect, it } from "vitest";
import { syncGitHubMergeGovernance } from "../../lib/github/governance.js";

describe("syncGitHubMergeGovernance", () => {
  it("returns a no-op result with github_app_removed skippedReason", async () => {
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
      attempted: false,
      requiredCheckConfigured: false,
      automergePrepared: false,
      mergeQueuePrepared: false,
      skippedReason: "github_app_removed",
    });
  });
});
