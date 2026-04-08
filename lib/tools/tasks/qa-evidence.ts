import { findPublicOutputViolations } from "./public-output-sanitizer.js";

export type QaEvidenceSubcause =
  | "qa_schema_missing"
  | "qa_section_count_invalid"
  | "qa_exit_code_missing"
  | "qa_exit_code_nonzero"
  | "qa_sanitization_failed"
  | "qa_missing_required_gates"
  | "qa_exit_codes_only"
  | "qa_coverage_below_threshold"
  | "qa_unknown";

export type QaEvidenceValidation = {
  valid: boolean;
  sectionCount: number;
  exitCode: number | null;
  problems: string[];
  /** Structured error codes for programmatic checks (mirrors problems for enhanced checks) */
  errors: string[];
  missingGates: string[];
  primarySubcause: QaEvidenceSubcause | null;
  fingerprint: string | null;
};

export type QaEvidenceActor = "developer" | "reviewer";

export function stripQaEvidenceSections(body: string): string {
  return body.replace(/\n## QA Evidence\b[\s\S]*?(?=\n##\s|\s*$)/gi, "").trimEnd();
}

function normalizeQaEvidenceForFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/\r/g, "")
    .replace(/exit code:\s*-?\d+/gi, "exit code")
    .replace(/\d+(?:\.\d+)?%/g, "<percent>")
    .replace(/\s+/g, " ")
    .trim();
}

function computeQaFingerprint(text: string): string | null {
  const normalized = normalizeQaEvidenceForFingerprint(text);
  if (!normalized) return null;
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16)}`;
}

export function classifyQaEvidenceSubcause(validation: Pick<QaEvidenceValidation, "sectionCount" | "exitCode" | "problems" | "errors">): QaEvidenceSubcause | null {
  if (validation.errors.includes("qa_evidence_missing")) return "qa_schema_missing";
  if (validation.sectionCount > 1) return "qa_section_count_invalid";
  if (validation.problems.some((problem) => problem.includes("host-system paths") || problem.includes("secrets") || problem.includes("environment dump"))) {
    return "qa_sanitization_failed";
  }
  if (validation.problems.some((problem) => problem.includes("Exit code: <number>"))) return "qa_exit_code_missing";
  if (validation.exitCode !== null && validation.exitCode !== 0) return "qa_exit_code_nonzero";
  if (validation.errors.includes("qa_evidence_only_exit_codes")) return "qa_exit_codes_only";
  if (validation.errors.some((error) => error.startsWith("qa_gate_missing_"))) return "qa_missing_required_gates";
  if (validation.errors.some((error) => error.startsWith("qa_coverage_below_threshold_"))) return "qa_coverage_below_threshold";
  return validation.errors.length || validation.problems.length ? "qa_unknown" : null;
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
  const missingGates: string[] = [];
  for (const [gate, aliases] of Object.entries(GATE_ALIASES)) {
    const found = aliases.some((alias) => new RegExp(alias, "i").test(section));
    if (!found) {
      missingGates.push(gate);
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

  const primarySubcause = classifyQaEvidenceSubcause({
    sectionCount,
    exitCode,
    problems,
    errors,
  });

  return {
    valid: problems.length === 0 && errors.length === 0,
    sectionCount,
    exitCode,
    problems,
    errors,
    missingGates,
    primarySubcause,
    fingerprint: computeQaFingerprint(section),
  };
}

export function validateCanonicalQaEvidence(body?: string | null): QaEvidenceValidation {
  return validateQaEvidence(body);
}

function buildQaRepairGuidance(validation: QaEvidenceValidation, actor: QaEvidenceActor): string[] {
  const base = actor === "developer"
    ? [
        'Run `scripts/qa.sh` again and replace the existing "## QA Evidence" section with the fresh sanitized output.',
        'Keep the canonical lint/types/security/tests/coverage gates intact.',
        'Do not rewrite or weaken `scripts/qa.sh` into ad-hoc scenario checks.',
      ]
    : [
        'Reject the PR and ask the developer to rerun `scripts/qa.sh`.',
        'Require the PR body to contain one fresh sanitized "## QA Evidence" section.',
        'Do not accept ad-hoc scenario scripts or weakened QA gates in place of the canonical contract.',
      ];

  switch (validation.primarySubcause) {
    case "qa_schema_missing":
    case "qa_section_count_invalid":
      return [
        ...base,
        'Ensure the PR body contains exactly one `## QA Evidence` section.',
      ];
    case "qa_exit_code_missing":
      return [
        ...base,
        'The QA Evidence must include an explicit `Exit code: 0` line.',
      ];
    case "qa_exit_code_nonzero":
      return [
        ...base,
        'The QA command failed. Fix the underlying lint/type/security/test/coverage problem before calling work_finish again.',
      ];
    case "qa_sanitization_failed":
      return [
        ...base,
        'Sanitize host paths, environment dumps, and secrets before updating the PR body.',
      ];
    case "qa_missing_required_gates":
      return [
        ...base,
        `Missing gates: ${validation.missingGates.join(", ") || "unknown"}. Include all required gates in the canonical QA output.`,
      ];
    case "qa_exit_codes_only":
      return [
        ...base,
        'Do not paste exit codes alone. Include the actual lint/types/security/tests/coverage output summary.',
      ];
    case "qa_coverage_below_threshold":
      return [
        ...base,
        'Coverage is below the required threshold. Fix the underlying tests or implementation before retrying.',
      ];
    default:
      return base;
  }
}

export function formatQaEvidenceValidationFailure(
  validation: QaEvidenceValidation,
  actor: QaEvidenceActor,
): string {
  const intro = actor === "developer"
    ? "Cannot mark work_finish(done) with invalid QA Evidence in the PR body."
    : "Cannot approve review with invalid QA Evidence in the PR body.";
  const allIssues = [...validation.problems, ...validation.errors];
  const guidance = buildQaRepairGuidance(validation, actor);
  return `${intro}\n\n${allIssues.map((issue) => `- ${issue}`).join("\n")}\n\n${guidance.map((line) => `- ${line}`).join("\n")}`;
}
