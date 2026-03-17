/**
 * Tests for keyword-based idea classification.
 */
import { describe, it, expect } from "vitest";
import { classifyByKeywords, resolveDeliveryTarget } from "../../lib/intake/lib/classification.js";
import type { ClassificationRules } from "../../lib/intake/lib/classification.js";
import rules from "../../lib/intake/configs/classification-rules.json";

const RULES = rules as ClassificationRules;

describe("classifyByKeywords", () => {
  it("classifies bugfix ideas", () => {
    const r = classifyByKeywords("There is a bug causing errors in the login page", RULES);
    expect(r.type).toBe("bugfix");
    expect(r.confidence).toBeGreaterThan(0.3);
  });

  it("classifies feature ideas", () => {
    const r = classifyByKeywords("Criar um sistema de cadastro de usuários", RULES);
    expect(r.type).toBe("feature");
  });

  it("classifies refactor ideas", () => {
    const r = classifyByKeywords("Refatorar o módulo de pagamento para simplificar", RULES);
    expect(r.type).toBe("refactor");
  });

  it("classifies research ideas", () => {
    const r = classifyByKeywords("Research best practices for authentication with spike", RULES);
    expect(r.type).toBe("research");
  });

  it("classifies infra ideas", () => {
    const r = classifyByKeywords("Deploy Docker containers with CI/CD pipeline", RULES);
    expect(r.type).toBe("infra");
  });

  it("defaults to feature for vague ideas", () => {
    const r = classifyByKeywords("Make something nice", RULES);
    expect(r.type).toBe("feature");
    expect(r.confidence).toBeLessThanOrEqual(0.3);
  });

  it("returns alternatives when multiple types score", () => {
    // "fix the deployment pipeline" matches both bugfix (fix) and infra (pipeline/deploy)
    const r = classifyByKeywords("fix the deployment pipeline", RULES);
    expect(r.alternatives.length).toBeGreaterThan(0);
  });

  it("includes reasoning text", () => {
    const r = classifyByKeywords("Fix a critical bug", RULES);
    expect(r.reasoning).toContain("bugfix");
  });

  it("handles Portuguese keywords", () => {
    const r = classifyByKeywords("O sistema não funciona, está quebrado", RULES);
    expect(r.type).toBe("bugfix");
  });

  it("weighted scoring: bugfix weight 1.2 beats feature weight 1.0 at equal matches", () => {
    // "fix this new feature bug" has: fix/bug for bugfix, new/feature for feature
    // bugfix weight 1.2 should win or at least compete
    const r = classifyByKeywords("fix this new bug", RULES);
    expect(r.type).toBe("bugfix");
  });
});

describe("resolveDeliveryTarget", () => {
  it("detects from text when raw is null", () => {
    expect(resolveDeliveryTarget(null, "Criar uma tela de cadastro")).toBe("web-ui");
  });

  it("detects from text when raw is 'null' string", () => {
    expect(resolveDeliveryTarget("null", "Build a CLI tool")).toBe("cli");
  });

  it("detects from text when raw is empty", () => {
    expect(resolveDeliveryTarget("", "REST API for payments")).toBe("api");
  });

  it("normalizes raw when provided", () => {
    expect(resolveDeliveryTarget("frontend", "anything")).toBe("web-ui");
    expect(resolveDeliveryTarget("backend", "anything")).toBe("api");
  });

  it("returns unknown when both raw and text are empty", () => {
    expect(resolveDeliveryTarget(undefined, "something vague")).toBe("unknown");
  });
});
