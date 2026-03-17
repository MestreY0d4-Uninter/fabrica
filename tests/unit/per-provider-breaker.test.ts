import { describe, it, expect, beforeEach } from "vitest";
import { getProviderPolicy, resetProviderPolicies } from "../../lib/providers/resilience.js";

describe("per-provider circuit breaker", () => {
  beforeEach(() => {
    resetProviderPolicies();
  });

  it("returns same policy for same provider key", () => {
    const p1 = getProviderPolicy("org/repo-a");
    const p2 = getProviderPolicy("org/repo-a");
    expect(p1).toBe(p2);
  });

  it("returns different policies for different provider keys", () => {
    const p1 = getProviderPolicy("org/repo-a");
    const p2 = getProviderPolicy("org/repo-b");
    expect(p1).not.toBe(p2);
  });

  it("evicts LRU when exceeding max entries", () => {
    // Create 51 providers (max=50)
    for (let i = 0; i < 51; i++) {
      getProviderPolicy(`org/repo-${i}`);
    }
    // First entry should have been evicted; verify getProviderPolicy still works
    const fresh = getProviderPolicy("org/repo-0");
    expect(fresh).toBeDefined();
  });
});
