/**
 * Tests for QA contract generation.
 */
import { describe, it, expect } from "vitest";
import { generateQaContract, getGateCommands, getStandardGates, getCoverageThreshold } from "../../lib/quality/qa-contracts.js";
import type { Spec } from "../../lib/intake/types.js";

const baseSpec: Spec = {
  title: "Word Counter CLI",
  type: "feature",
  objective: "Build a CLI to count words",
  scope_v1: ["Implement word counting"],
  out_of_scope: ["GUI"],
  acceptance_criteria: ["O programa conta palavras corretamente", "Aceita arquivos como entrada"],
  definition_of_done: ["Tests pass", "Coverage >= 80%"],
  constraints: "Delivery target: cli.",
  risks: [],
  delivery_target: "cli",
};

describe("generateQaContract", () => {
  it("generates 5 standard gates", () => {
    const qc = generateQaContract({ spec: baseSpec, stack: "python-cli" });
    expect(qc.gates).toEqual(["lint", "types", "security", "tests", "coverage"]);
  });

  it("includes acceptance criteria as acceptance_tests", () => {
    const qc = generateQaContract({ spec: baseSpec, stack: "python-cli" });
    expect(qc.acceptance_tests).toEqual(baseSpec.acceptance_criteria);
  });

  it("generates script content with Python tools for python-cli", () => {
    const qc = generateQaContract({ spec: baseSpec, stack: "python-cli" });
    expect(qc.script_content).toContain("ruff check src/ tests/");
    expect(qc.script_content).toContain("mypy src/");
    expect(qc.script_content).toContain("pytest tests/");
    expect(qc.script_content).toContain("pip-audit");
    expect(qc.script_content).toContain("cov-fail-under=80");
    expect(qc.script_content).toContain(".venv");
    expect(qc.script_content).toContain("pip install -e '.[dev]'");
  });

  it("generates script with JS tools for nextjs", () => {
    const qc = generateQaContract({ spec: baseSpec, stack: "nextjs" });
    expect(qc.script_content).toContain("next lint");
    expect(qc.script_content).toContain("tsc --noEmit");
    expect(qc.script_content).toContain("npm test");
    expect(qc.script_content).toContain("npm audit");
    expect(qc.script_content).toContain("vitest");
    expect(qc.script_content).toContain("node_modules/.bin");
    expect(qc.script_content).toContain("package-lock.json");
  });

  it("generates script with JS tools for node-cli", () => {
    const qc = generateQaContract({ spec: baseSpec, stack: "node-cli" });
    expect(qc.script_content).toContain("npm run lint");
    expect(qc.script_content).toContain("npm run typecheck");
    expect(qc.script_content).toContain("npm test");
    expect(qc.script_content).toContain("npm run coverage");
    expect(qc.script_content).toContain("npm audit");
    expect(qc.script_content).toContain("node_modules/.bin");
  });

  it("generates script with Go tools for go", () => {
    const qc = generateQaContract({ spec: baseSpec, stack: "go" });
    expect(qc.script_content).toContain("go vet");
    expect(qc.script_content).toContain("go test");
    expect(qc.script_content).toContain("govulncheck");
    expect(qc.script_content).toContain("coverprofile");
  });

  it("generates script with Java tools for java", () => {
    const qc = generateQaContract({ spec: baseSpec, stack: "java" });
    expect(qc.script_content).toContain("mvn");
    expect(qc.script_content).toContain("checkstyle");
    expect(qc.script_content).toContain("dependency-check");
  });

  it("includes project-local bootstrap for Python stacks", () => {
    const qc = generateQaContract({ spec: baseSpec, stack: "fastapi" });
    expect(qc.script_content).toContain(".venv");
    expect(qc.script_content).toContain("requirements.txt");
    expect(qc.script_content).toContain("pyproject.toml");
    expect(qc.script_content).toContain("ruff check app/ tests/");
  });

  it("uses deterministic local bootstrap for JS stacks", () => {
    const qc = generateQaContract({ spec: baseSpec, stack: "node-cli" });
    expect(qc.script_content).toContain("node_modules/.bin");
    expect(qc.script_content).not.toContain("QA_VENV");
  });

  it("includes acceptance criteria as comments in script", () => {
    const qc = generateQaContract({ spec: baseSpec, stack: "python-cli" });
    expect(qc.script_content).toContain("AC1:");
    expect(qc.script_content).toContain("AC2:");
    expect(qc.script_content).toContain("conta palavras");
  });

  it("uses custom acceptance criteria when provided", () => {
    const qc = generateQaContract({
      spec: baseSpec,
      stack: "python-cli",
      acceptanceCriteria: ["Custom AC 1", "Custom AC 2"],
    });
    expect(qc.acceptance_tests).toEqual(["Custom AC 1", "Custom AC 2"]);
    expect(qc.script_content).toContain("Custom AC 1");
  });

  it("script has proper structure (shebang, set -euo, gate function, summary)", () => {
    const qc = generateQaContract({ spec: baseSpec, stack: "python-cli" });
    expect(qc.script_content).toMatch(/^#!/);
    expect(qc.script_content).toContain("set -euo pipefail");
    expect(qc.script_content).toContain("gate()");
    expect(qc.script_content).toContain("QA Summary");
    expect(qc.script_content).toContain("exit 0");
    expect(qc.script_content).toContain("exit 1");
  });
});

describe("getGateCommands", () => {
  it("returns Python commands for Python stacks", () => {
    const cmds = getGateCommands("fastapi");
    expect(cmds.lint).toBe("ruff check app/ tests/");
    expect(cmds.types).toContain("mypy app/");
  });

  it("returns JS commands for JS stacks", () => {
    expect(getGateCommands("nextjs").lint).toContain("next lint");
    expect(getGateCommands("node-cli").lint).toContain("npm run lint");
    const cmds = getGateCommands("express");
    expect(cmds.lint).toContain("eslint");
  });

  it("returns Go commands for go", () => {
    const cmds = getGateCommands("go");
    expect(cmds.lint).toBe("go vet ./...");
  });
});

describe("getStandardGates", () => {
  it("returns 5 gate names", () => {
    expect(getStandardGates()).toHaveLength(5);
    expect(getStandardGates()).toContain("lint");
    expect(getStandardGates()).toContain("coverage");
  });
});

describe("getCoverageThreshold", () => {
  it("returns 80", () => {
    expect(getCoverageThreshold()).toBe(80);
  });
});
