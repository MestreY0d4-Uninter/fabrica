/**
 * Stack-specific delivery criteria.
 *
 * Defines what "ready to deliver" means per stack:
 * tools, minimum thresholds, and required passes.
 */
import type { CanonicalStack } from "../intake/types.js";
import { getStackFlags } from "../intake/lib/stack-detection.js";
import { getQaGateCommands } from "../test-env/bootstrap.js";

export type DeliveryCriterion = {
  name: string;
  command: string;
  required: boolean;
  description: string;
};

export type DeliveryCriteria = {
  stack: CanonicalStack;
  criteria: DeliveryCriterion[];
  coverageThreshold: number;
};

function criteriaFor(stack: CanonicalStack): DeliveryCriterion[] {
  const commands = getQaGateCommands(stack);
  const flags = getStackFlags(stack);

  if (flags.IS_PY) {
    return [
      { name: "lint", command: commands.lint, required: true, description: "Ruff linter passes with zero violations" },
      { name: "types", command: commands.types, required: true, description: "Mypy type checking passes" },
      { name: "tests", command: commands.tests, required: true, description: "All pytest tests pass" },
      { name: "coverage", command: commands.coverage, required: true, description: "Test coverage >= 80%" },
      { name: "security", command: commands.security, required: true, description: "pip-audit finds no known vulnerabilities" },
    ];
  }

  if (flags.IS_JS) {
    return [
      { name: "lint", command: commands.lint, required: true, description: "Lint checks pass with zero violations" },
      { name: "types", command: commands.types, required: true, description: "TypeScript type checking passes" },
      { name: "tests", command: commands.tests, required: true, description: "All tests pass" },
      { name: "coverage", command: commands.coverage, required: true, description: "Test coverage >= 80%" },
      { name: "security", command: commands.security, required: true, description: "npm audit finds no moderate+ vulnerabilities" },
    ];
  }

  if (flags.IS_GO) {
    return [
      { name: "lint", command: commands.lint, required: true, description: "go vet passes" },
      { name: "types", command: commands.types, required: true, description: "Go compilation succeeds" },
      { name: "tests", command: commands.tests, required: true, description: "All Go tests pass" },
      { name: "coverage", command: commands.coverage, required: true, description: "Test coverage >= 80%" },
      { name: "security", command: commands.security, required: true, description: "govulncheck finds no known vulnerabilities" },
    ];
  }

  return [
    { name: "lint", command: commands.lint, required: true, description: "Checkstyle passes" },
    { name: "types", command: commands.types, required: true, description: "Java compilation succeeds" },
    { name: "tests", command: commands.tests, required: true, description: "All Maven tests pass" },
    { name: "coverage", command: commands.coverage, required: true, description: "JaCoCo coverage >= 80%" },
    { name: "security", command: commands.security, required: true, description: "OWASP dependency check passes" },
  ];
}

/**
 * Get delivery criteria for a given stack.
 */
export function getDeliveryCriteria(stack: CanonicalStack): DeliveryCriteria {
  return { stack, criteria: criteriaFor(stack), coverageThreshold: 80 };
}

/**
 * Get all supported stacks and their criteria counts.
 */
export function listSupportedStacks(): Array<{ stack: CanonicalStack; criteriaCount: number }> {
  const stacks: CanonicalStack[] = ["python-cli", "fastapi", "flask", "django", "nextjs", "node-cli", "express", "go", "java"];
  return stacks.map(s => ({ stack: s, criteriaCount: getDeliveryCriteria(s).criteria.length }));
}
