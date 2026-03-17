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

  // 1. Required gate presence check
  const GATE_NAMES = ["lint", "types", "security", "tests", "coverage"] as const;
  for (const gate of GATE_NAMES) {
    const gateRegex = new RegExp(`###?\\s*${gate}`, "i");
    if (!gateRegex.test(section)) {
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
  const coverageThreshold = 80;
  const coverageMatch = section.match(/(\d+(?:\.\d+)?)%/);
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
    ? 'Replace the existing "## QA Evidence" section with fresh sanitized output from scripts/qa.sh (exactly one section, Exit code: 0), then call work_finish again.'
    : 'Reject the PR and instruct the developer to replace the existing "## QA Evidence" section in the PR body with fresh sanitized output from scripts/qa.sh (exactly one section, Exit code: 0).';

  return `${intro}\n\n${validation.problems.map((problem) => `- ${problem}`).join("\n")}\n\n${guidance}`;
}
