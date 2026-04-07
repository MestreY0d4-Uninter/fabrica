import { describe, expect, it } from "vitest";
import { resolveQualityGatePolicy } from "../../lib/quality/quality-gates.js";

describe("resolveQualityGatePolicy", () => {
  it("returns API gates with a medium floor by default", () => {
    const policy = resolveQualityGatePolicy({ deliverable: "api" });
    expect(policy.requiredChecks).toEqual(expect.arrayContaining(["startup/build", "endpoint validation"]));
    expect(policy.qualityCriticalityFloor).toBe("medium");
  });

  it("raises the floor when quality criticality is high", () => {
    const policy = resolveQualityGatePolicy({ deliverable: "cli", qualityCriticality: "high" });
    expect(policy.qualityCriticalityFloor).toBe("high");
  });

  it("falls back safely for unknown deliverables", () => {
    const policy = resolveQualityGatePolicy({ deliverable: "unknown" });
    expect(policy.requiredEvidence).toEqual(expect.arrayContaining(["basic behavioral evidence"]));
  });
});
