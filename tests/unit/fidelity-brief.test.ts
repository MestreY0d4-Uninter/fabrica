import { describe, expect, it } from "vitest";
import { buildFidelityBrief } from "../../lib/intake/lib/fidelity-brief.js";
import type { PipelineMetadata, Spec } from "../../lib/intake/types.js";

function makeMetadata(overrides: Partial<PipelineMetadata> = {}): PipelineMetadata {
  return {
    source: "test",
    factory_change: false,
    ...overrides,
  };
}

function makeSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    title: "Spec title",
    type: "feature",
    objective: "Build a production-ready API for task tracking.",
    scope_v1: ["Create REST endpoints", "Persist tasks in a database"],
    out_of_scope: ["Mobile app"],
    acceptance_criteria: ["Users can create tasks", "Users can list tasks"],
    definition_of_done: ["Tests pass", "README updated"],
    constraints: "Use FastAPI and keep it self-hosted.",
    risks: ["Authentication must be secure"],
    delivery_target: "api",
    ...overrides,
  };
}

describe("buildFidelityBrief", () => {
  it("extracts a strong API brief with quality and risk signals", () => {
    const brief = buildFidelityBrief({
      rawIdea: "Build a production-ready API for task tracking with secure auth and high performance.",
      spec: makeSpec(),
      metadata: makeMetadata({ stack_hint: "fastapi", stack_confidence: "high", delivery_target: "api" }),
    });

    expect(brief.primary_objective).toContain("production-ready API");
    expect(brief.requested_deliverable).toBe("api");
    expect(brief.requested_stack).toBe("fastapi");
    expect(brief.quality_expectations).toEqual(expect.arrayContaining(["production_ready", "performance", "security"]));
    expect(brief.risk_signals).toEqual(expect.arrayContaining(["auth_security_sensitive", "data_model_change", "performance_sensitive"]));
    expect(brief.explicit_non_goals).toContain("Mobile app");
    expect(brief.confidence).toBe("high");
  });

  it("infers CLI deliverable from raw idea when no delivery target is present", () => {
    const brief = buildFidelityBrief({
      rawIdea: "Create a small CLI that compares two env files and prints the diff.",
      metadata: makeMetadata(),
    });

    expect(brief.requested_deliverable).toBe("cli");
    expect(brief.ambiguity_flags).toContain("missing_structured_scope");
    expect(brief.confidence).toBe("low");
  });

  it("surfaces ambiguity when the request lacks clear deliverable and stack", () => {
    const brief = buildFidelityBrief({
      rawIdea: "Build something for customer onboarding.",
      metadata: makeMetadata(),
    });

    expect(brief.requested_deliverable).toBe("unknown");
    expect(brief.ambiguity_flags).toEqual(expect.arrayContaining(["ambiguous_deliverable", "missing_structured_scope"]));
    expect(brief.confidence).toBe("low");
  });

  it("captures explicit non-goals and soft preferences", () => {
    const brief = buildFidelityBrief({
      rawIdea: "Build a simple web app dashboard, prefer a modern stack, but do not add billing.",
      spec: makeSpec({
        objective: "Build a simple internal dashboard.",
        delivery_target: "web-ui",
        scope_v1: ["Show project metrics", "Render a clean dashboard"],
        out_of_scope: ["Billing module"],
        constraints: "Prefer modern tools, keep the implementation simple.",
      }),
      metadata: makeMetadata({ delivery_target: "web-ui" }),
    });

    expect(brief.requested_deliverable).toBe("web-ui");
    expect(brief.soft_preferences).toEqual(expect.arrayContaining(["explicit_preference", "modern_stack_preference", "simplicity_preference"]));
    expect(brief.explicit_non_goals).toEqual(expect.arrayContaining(["no_extra_features", "Billing module"]));
  });
});
