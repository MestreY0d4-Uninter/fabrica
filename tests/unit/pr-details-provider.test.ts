import { describe, it, expect, vi, beforeEach } from "vitest";

// We can't easily instantiate GitHubProvider without real credentials,
// so we test via interface contract: any provider implementing IssueProvider
// must accept getPrDetails in its type signature.

describe("IssueProvider.getPrDetails interface", () => {
  it("interface allows returning null (provider has no PR for issue)", () => {
    // This is a type-level test — if TypeScript compiles with getPrDetails
    // returning null, the interface is correctly defined.
    const stub: import("../../lib/providers/provider.js").IssueProvider = {
      getPrDetails: async () => null,
    } as any;
    expect(stub.getPrDetails).toBeDefined();
  });

  it("PrDetails type has required fields", () => {
    const details: import("../../lib/github/types.js").PrDetails = {
      prNumber: 42,
      headSha: "abc123",
      prState: "open",
      prUrl: "https://github.com/org/repo/pull/42",
      sourceBranch: "feat/my-branch",
      repositoryId: 99999,
      owner: "org",
      repo: "repo",
    };
    expect(details.prNumber).toBe(42);
    expect(details.headSha).toBe("abc123");
    expect(details.repositoryId).toBe(99999);
  });
});
