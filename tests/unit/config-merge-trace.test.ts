import { describe, it, expect } from "vitest";
import { mergeConfigWithTrace } from "../../lib/config/merge.js";
import type { FabricaConfig } from "../../lib/config/types.js";

describe("mergeConfigWithTrace", () => {
  it("traces which layer contributed each value", () => {
    const base: FabricaConfig = {
      workflow: { reviewPolicy: "human" },
      timeouts: { gitPullMs: 30000 },
    };
    const overlay: FabricaConfig = {
      workflow: { reviewPolicy: "agent" },
    };

    const { merged, trace } = mergeConfigWithTrace(base, overlay, "built-in", "workspace");

    expect(merged.workflow?.reviewPolicy).toBe("agent");
    expect(trace["workflow.reviewPolicy"]).toBe("workspace");
    expect(trace["timeouts.gitPullMs"]).toBe("built-in");
  });

  it("traces role overrides", () => {
    const base: FabricaConfig = {
      roles: { developer: { defaultLevel: "junior" } },
    };
    const overlay: FabricaConfig = {
      roles: { developer: { defaultLevel: "senior" } },
    };

    const { trace } = mergeConfigWithTrace(base, overlay, "built-in", "project:my-project");
    expect(trace["roles.developer.defaultLevel"]).toBe("project:my-project");
  });

  it("traces timeout overrides", () => {
    const base: FabricaConfig = { timeouts: { staleWorkerHours: 2 } };
    const overlay: FabricaConfig = { timeouts: { staleWorkerHours: 4 } };

    const { trace } = mergeConfigWithTrace(base, overlay, "workspace", "project:x");
    expect(trace["timeouts.staleWorkerHours"]).toBe("project:x");
  });
});
