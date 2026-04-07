import { describe, expect, it } from "vitest";
import { resolveStackPolicy } from "../../lib/quality/stack-policies.js";

describe("resolveStackPolicy", () => {
  it("returns api defaults with medium quality floor", () => {
    const policy = resolveStackPolicy({ deliverable: "api" });
    expect(policy.archetype).toBe("api");
    expect(policy.requiredChecks).toEqual(expect.arrayContaining(["startup/build", "request-level tests"]));
    expect(policy.qualityCriticalityFloor).toBe("medium");
  });

  it("adds stack-specific guidance for fastapi", () => {
    const policy = resolveStackPolicy({ deliverable: "api", stackHint: "fastapi" });
    expect(policy.stack).toBe("fastapi");
    expect(policy.preferredLibraries).toEqual(expect.arrayContaining(["pydantic schemas", "pytest"]));
  });

  it("raises the quality floor when the caller marks the project as high criticality", () => {
    const policy = resolveStackPolicy({ deliverable: "cli", qualityCriticality: "high" });
    expect(policy.qualityCriticalityFloor).toBe("high");
  });

  it("falls back safely for unknown deliverables", () => {
    const policy = resolveStackPolicy({ deliverable: "unknown", stackHint: null });
    expect(policy.archetype).toBe("unknown");
    expect(policy.requiredChecks).toEqual(expect.arrayContaining(["build or execution smoke", "basic tests"]));
  });
});
