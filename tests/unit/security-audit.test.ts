/**
 * Tests for security audit / spec security review.
 */
import { describe, it, expect, vi } from "vitest";
import { reviewSpecSecurity, runExternalAudit } from "../../lib/quality/security-audit.js";
import type { Spec, AuthGate } from "../../lib/intake/types.js";

const baseSpec: Spec = {
  title: "Word Counter CLI",
  type: "feature",
  objective: "Build a CLI to count words in files",
  scope_v1: ["Implement word counting from stdin and files"],
  out_of_scope: ["GUI"],
  acceptance_criteria: ["O programa conta palavras corretamente"],
  definition_of_done: ["Tests pass"],
  constraints: "Delivery target: cli.",
  risks: [],
  delivery_target: "cli",
};

describe("reviewSpecSecurity", () => {
  it("returns LOW for simple CLI with no security concerns", () => {
    const r = reviewSpecSecurity({ spec: baseSpec, rawIdea: "Contar palavras em arquivos" });
    expect(r.recommendation).toBe("LOW security sensitivity");
    expect(r.spec_security_notes).toHaveLength(0);
    expect(r.audit_ran).toBe(true);
  });

  it("detects authentication patterns", () => {
    const spec = { ...baseSpec, objective: "Build a login system with authentication" };
    const r = reviewSpecSecurity({ spec, rawIdea: "sistema de login" });
    expect(r.spec_security_notes.length).toBeGreaterThan(0);
    expect(r.spec_security_notes.some(n => n.includes("Authentication"))).toBe(true);
  });

  it("detects password handling", () => {
    const spec = { ...baseSpec, scope_v1: ["Implementar reset de senha"] };
    const r = reviewSpecSecurity({ spec, rawIdea: "sistema com senha" });
    expect(r.spec_security_notes.some(n => n.includes("Password"))).toBe(true);
  });

  it("detects API security concerns", () => {
    const spec = { ...baseSpec, scope_v1: ["Create REST API endpoints"] };
    const r = reviewSpecSecurity({ spec, rawIdea: "API de pagamentos" });
    expect(r.spec_security_notes.some(n => n.includes("API detected"))).toBe(true);
  });

  it("detects database/SQL concerns", () => {
    const spec = { ...baseSpec, scope_v1: ["Query database for user records"] };
    const r = reviewSpecSecurity({ spec, rawIdea: "sistema com banco de dados" });
    expect(r.spec_security_notes.some(n => n.includes("Database"))).toBe(true);
  });

  it("detects file upload concerns", () => {
    const spec = { ...baseSpec, scope_v1: ["Allow file upload of images"] };
    const r = reviewSpecSecurity({ spec, rawIdea: "upload de arquivos" });
    expect(r.spec_security_notes.some(n => n.includes("File upload"))).toBe(true);
  });

  it("detects payment/PCI concerns", () => {
    const spec = { ...baseSpec, scope_v1: ["Process credit card payments via Stripe"] };
    const r = reviewSpecSecurity({ spec, rawIdea: "sistema de pagamento" });
    expect(r.spec_security_notes.some(n => n.includes("PCI DSS"))).toBe(true);
  });

  it("detects JWT/token concerns", () => {
    const spec = { ...baseSpec, scope_v1: ["JWT-based authentication with refresh tokens"] };
    const r = reviewSpecSecurity({ spec, rawIdea: "auth com JWT" });
    expect(r.spec_security_notes.some(n => n.includes("Token-based"))).toBe(true);
  });

  it("detects admin panel concerns", () => {
    const spec = { ...baseSpec, scope_v1: ["Admin dashboard for user management"] };
    const r = reviewSpecSecurity({ spec, rawIdea: "painel admin" });
    expect(r.spec_security_notes.some(n => n.includes("Admin"))).toBe(true);
  });

  it("detects webhook concerns", () => {
    const spec = { ...baseSpec, scope_v1: ["Receive webhook callbacks from Stripe"] };
    const r = reviewSpecSecurity({ spec, rawIdea: "webhook integration" });
    expect(r.spec_security_notes.some(n => n.includes("Webhook"))).toBe(true);
  });

  it("detects secrets/encryption concerns", () => {
    const spec = { ...baseSpec, scope_v1: ["Encrypt sensitive data at rest"] };
    const r = reviewSpecSecurity({ spec, rawIdea: "criptografia de dados" });
    expect(r.spec_security_notes.some(n => n.includes("Secrets/encryption"))).toBe(true);
  });

  it("returns MODERATE for 1-3 security notes", () => {
    const spec = { ...baseSpec, scope_v1: ["REST API with database"] };
    const r = reviewSpecSecurity({ spec, rawIdea: "API com banco de dados" });
    expect(r.recommendation).toMatch(/MODERATE|HIGH/);
  });

  it("returns HIGH for >3 security notes", () => {
    const spec = {
      ...baseSpec,
      objective: "Build admin login with JWT authentication",
      scope_v1: ["API endpoints", "Database queries", "File upload", "Payment processing"],
    };
    const r = reviewSpecSecurity({ spec, rawIdea: "sistema admin com login, API, banco de dados, upload, pagamento" });
    expect(r.recommendation).toBe("HIGH security sensitivity");
  });

  it("detects auth gate drift", () => {
    const authGate: AuthGate = { signal: true, evidence: false };
    const r = reviewSpecSecurity({ spec: baseSpec, rawIdea: "simple app", authGate });
    expect(r.spec_security_notes.some(n => n.includes("contract drift"))).toBe(true);
    expect(r.recommendation).toBe("HIGH security sensitivity");
  });

  it("no drift when auth gate has evidence", () => {
    const authGate: AuthGate = { signal: true, evidence: true };
    const r = reviewSpecSecurity({ spec: baseSpec, rawIdea: "simple app", authGate });
    expect(r.spec_security_notes.some(n => n.includes("contract drift"))).toBe(false);
  });
});

describe("runExternalAudit", () => {
  it("returns original review when no supplemental audit output is available", async () => {
    const review = reviewSpecSecurity({ spec: baseSpec, rawIdea: "test" });
    const mockRun = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const result = await runExternalAudit(review, mockRun);
    expect(result).toEqual(review);
  });

  it("extracts findings and score from audit output", async () => {
    const review = reviewSpecSecurity({ spec: baseSpec, rawIdea: "test" });
    const mockRun = vi.fn().mockResolvedValue({
      stdout: "🔴 CRITICAL: hardcoded secret found\n🟠 HIGH: weak permissions\n✅ PASS: gateway auth\nSecurity Score: 75",
      stderr: "",
      exitCode: 0,
    });
    const result = await runExternalAudit(review, mockRun);
    expect(result.score).toBe(75);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toContain("hardcoded secret");
    expect(result.findings[1]).toContain("weak permissions");
  });

  it("handles audit command failure gracefully", async () => {
    const review = reviewSpecSecurity({ spec: baseSpec, rawIdea: "test" });
    const mockRun = vi.fn().mockRejectedValue(new Error("command failed"));
    const result = await runExternalAudit(review, mockRun);
    expect(result).toEqual(review);
  });
});
