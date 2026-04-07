import { findPublicOutputViolations } from "./public-output-sanitizer.js";

export type QaEvidenceValidation = {
  valid: boolean;
  sectionCount: number;
  exitCode: number | null;
  problems: string[];
  /** Structured error codes for programmatic checks (mirrors problems for enhanced checks) */
  errors: string[];
};

export type QaEvidenceActor = "developer" | "reviewer";

export function stripQaEvidenceSections(body: string): string {
  return body.replace(/\n## QA Evidence\b[\s\S]*?(?=\n##\s|\s*$)/gi, "").trimEnd();
}

export function validateQaEvidence(body?: string | null): QaEvidenceValidation {
  const text = body ?? "";
  const headings = [...text.matchAll(/^## QA Evidence\b[\t ]*$/gim)];
  const problems: string[] = [];
  const errors: string[] = [];
  const sectionCount = headings.length;

  if (sectionCount !== 1) {
    if (sectionCount === 0) {
      problems.push("PR body is missing a `## QA Evidence` section.");
      errors.push("qa_evidence_missing");
    } else {
      problems.push("PR body must contain exactly one `## QA Evidence` section.");
    }
  }

  let qaBody = "";
  if (headings.length === 1) {
    const heading = headings[0]!;
    const start = (heading.index ?? 0) + heading[0].length;
    const remainder = text.slice(start);
    const nextHeading = remainder.search(/^##\s+/m);
    qaBody = (nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder).trim();
  }
  const exitMatch = qaBody.match(/Exit code:\s*(-?\d+)/i);
  const exitCode = exitMatch ? Number.parseInt(exitMatch[1]!, 10) : null;

  if (sectionCount > 0 && exitCode === null) {
    problems.push("QA Evidence must include an `Exit code: <number>` line.");
  }
  if (exitCode !== null && exitCode !== 0) {
    problems.push(`QA Evidence exit code must be 0, got ${exitCode}.`);
  }

  const violations = findPublicOutputViolations(qaBody);
  if (violations.includes("path")) {
    problems.push("QA Evidence still contains host-system paths.");
  }
  if (violations.includes("secret")) {
    problems.push("QA Evidence still contains secrets or environment values.");
  }
  if (violations.includes("env_dump")) {
    problems.push("QA Evidence still contains environment dump output.");
  }

  // Enhanced checks — structured error codes
  const section = qaBody;

  // 1. Required gate presence check.
  // Accepts both markdown headings (## lint) and horizontal-rule delimiters (--- Ruff lint ---),
  // plus tool-name aliases so scripts using "Mypy" still satisfy the "types" gate, etc.
  const GATE_ALIASES: Record<string, string[]> = {
    lint:     ["lint", "ruff", "eslint", "golangci", "flake8", "pylint"],
    types:    ["types", "mypy", "tsc", "typecheck", "type.check"],
    security: ["security", "secret", "audit", "pip.audit", "npm.audit"],
    tests:    ["tests", "pytest", "jest", "vitest", "go test", "test session"],
    coverage: ["coverage"],
  };
  for (const [gate, aliases] of Object.entries(GATE_ALIASES)) {
    const found = aliases.some((alias) => new RegExp(alias, "i").test(section));
    if (!found) {
      errors.push(`qa_gate_missing_${gate}`);
    }
  }

  // 2. Exit-code-only detection — reject evidence with ≥80% exit-code lines
  const contentLines = section.split("\n").filter((l) => l.trim());
  const exitCodeLines = contentLines.filter((l) => /Exit code:\s*\d+/i.test(l));
  if (exitCodeLines.length > 0 && exitCodeLines.length >= contentLines.length * 0.8) {
    errors.push("qa_evidence_only_exit_codes");
  }

  // 3. Coverage threshold check (default: 80%)
  // Use specific coverage-summary patterns to avoid matching test progress like "[ 14%]"
  const coverageThreshold = 80;
  const coverageMatch =
    section.match(/total coverage:\s*(\d+(?:\.\d+)?)%/i) ??
    section.match(/^TOTAL\b.*?(\d+(?:\.\d+)?)%/m) ??
    section.match(/^Statements\s*:\s*(\d+(?:\.\d+)?)%/m) ??
    section.match(/^All files\b.*?(\d+(?:\.\d+)?)%/m);
  if (coverageMatch) {
    const cov = parseFloat(coverageMatch[1]!);
    if (cov < coverageThreshold) {
      errors.push(`qa_coverage_below_threshold_${Math.floor(cov)}`);
    }
  }

  return {
    valid: problems.length === 0 && errors.length === 0,
    sectionCount,
    exitCode,
    problems,
    errors,
  };
}

export function validateCanonicalQaEvidence(body?: string | null): QaEvidenceValidation {
  return validateQaEvidence(body);
}

export function formatQaEvidenceValidationFailure(
  validation: QaEvidenceValidation,
  actor: QaEvidenceActor,
): string {
  const intro = actor === "developer"
    ? "Cannot mark work_finish(done) with invalid QA Evidence in the PR body."
    : "Cannot approve review with invalid QA Evidence in the PR body.";
  const guidance = actor === "developer"
    ? 'Replace the existing "## QA Evidence" section with fresh sanitized output from scripts/qa.sh (exactly one section, Exit code: 0), then call work_finish again. Do not rewrite or weaken scripts/qa.sh into ad-hoc scenario checks — preserve the canonical lint/types/security/tests/coverage gates and fix the underlying code or project setup instead.'
    : 'Reject the PR and instruct the developer to replace the existing "## QA Evidence" section in the PR body with fresh sanitized output from scripts/qa.sh (exactly one section, Exit code: 0). Do not accept ad-hoc scenario scripts or weakened QA gates in place of the canonical lint/types/security/tests/coverage contract.';

  const allIssues = [...validation.problems, ...validation.errors];
  return `${intro}\n\n${allIssues.map((issue) => `- ${issue}`).join("\n")}\n\n${guidance}`;
}
