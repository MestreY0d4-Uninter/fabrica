import { describe, it, expect } from "vitest";
import { needsHumanSecurity } from "../../lib/intake/steps/security-review.js";

describe("needsHumanSecurity", () => {
  it("returns true when score < 40 and auth signal present", () => {
    expect(needsHumanSecurity(35, true)).toBe(true);
  });

  it("returns false when score >= 40", () => {
    expect(needsHumanSecurity(60, true)).toBe(false);
  });

  it("returns false when no auth signal regardless of score", () => {
    expect(needsHumanSecurity(35, false)).toBe(false);
  });
});
