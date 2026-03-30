import { describe, it, expect, beforeEach } from "vitest";
import { withResilience, resetProviderPolicies, GitHubRateLimitError } from "../../lib/providers/resilience.js";

describe("rate limit resilience", () => {
  beforeEach(() => resetProviderPolicies());

  it("retries GitHubRateLimitError up to 2 times with delay", async () => {
    let callCount = 0;
    await expect(
      withResilience(async () => {
        callCount++;
        throw new GitHubRateLimitError(10); // short delay for test
      }, "test-repo", { jitterMaxMs: 0 }),
    ).rejects.toThrow(GitHubRateLimitError);
    // 1 initial + 2 retries = 3 total
    expect(callCount).toBe(3);
  });

  it("retries non-rate-limit errors up to 3 times", async () => {
    let callCount = 0;
    await expect(
      withResilience(async () => {
        callCount++;
        throw new Error("transient failure");
      }, "test-repo"),
    ).rejects.toThrow("transient failure");
    expect(callCount).toBe(4);
  });
});
