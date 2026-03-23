import { describe, it, expect, beforeEach } from "vitest";
import { withResilience, resetProviderPolicies, GitHubRateLimitError } from "../../lib/providers/resilience.js";

describe("rate limit resilience", () => {
  beforeEach(() => resetProviderPolicies());

  it("does not retry GitHubRateLimitError", async () => {
    let callCount = 0;
    await expect(
      withResilience(async () => {
        callCount++;
        throw new GitHubRateLimitError(60_000);
      }, "test-repo"),
    ).rejects.toThrow(GitHubRateLimitError);
    expect(callCount).toBe(1);
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
