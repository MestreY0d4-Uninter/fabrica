import { describe, expect, it } from "vitest";
import { resolveDonePolicy } from "../../lib/quality/done-policies.js";

describe("resolveDonePolicy", () => {
  it("returns CLI done requirements with command/help expectations", () => {
    const policy = resolveDonePolicy({ deliverable: "cli" });
    expect(policy.requiredArtifacts).toEqual(expect.arrayContaining(["command entrypoint", "help contract"]));
    expect(policy.behavioralChecks).toEqual(expect.arrayContaining(["help works", "main command succeeds"]));
  });

  it("raises the floor when quality criticality is high", () => {
    const policy = resolveDonePolicy({ deliverable: "api", qualityCriticality: "high" });
    expect(policy.qualityCriticalityFloor).toBe("high");
  });

  it("falls back safely for unknown deliverables", () => {
    const policy = resolveDonePolicy({ deliverable: "unknown" });
    expect(policy.requiredEvidence).toEqual(expect.arrayContaining(["basic runnable evidence"]));
  });
});
