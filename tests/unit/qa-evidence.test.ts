import { describe, expect, it } from "vitest";
import {
  formatQaEvidenceValidationFailure,
  stripQaEvidenceSections,
  validateCanonicalQaEvidence,
  validateQaEvidence,
} from "../../lib/tools/tasks/qa-evidence.js";

describe("qa evidence validation", () => {
  it("accepts a single sanitized QA Evidence section with exit code 0", () => {
    const body = `## Summary

Something changed.

## QA Evidence

\`\`\`
all tests passed
\`\`\`

Exit code: 0
`;

    expect(validateQaEvidence(body)).toEqual({
      valid: true,
      sectionCount: 1,
      exitCode: 0,
      problems: [],
    });
  });

  it("canonical validator delegates to the same PR-body QA rules", () => {
    const body = `## Summary

Something changed.

## QA Evidence

\`\`\`
all tests passed
\`\`\`

Exit code: 0
`;

    expect(validateCanonicalQaEvidence(body)).toEqual(validateQaEvidence(body));
  });

  it("rejects duplicated QA Evidence sections", () => {
    const body = `## Summary

## QA Evidence

\`\`\`
old run
\`\`\`

Exit code: 127

## Changes

- fixed something

## QA Evidence

\`\`\`
new run
\`\`\`

Exit code: 0
`;

    const result = validateQaEvidence(body);
    expect(result.valid).toBe(false);
    expect(result.problems.join("\n")).toMatch(/exactly one/);
  });

  it("rejects host-path leakage in QA Evidence", () => {
    const body = `## QA Evidence

\`\`\`
/home/mateus/project/scripts/qa.sh
\`\`\`

Exit code: 0
`;

    const result = validateQaEvidence(body);
    expect(result.valid).toBe(false);
    expect(result.problems).toContain("QA Evidence still contains host-system paths.");
  });

  it("rejects macOS and Windows host-path leakage in QA Evidence", () => {
    const body = `## QA Evidence

\`\`\`
/Users/mateus/project/scripts/qa.sh
C:\\Users\\mateus\\project\\qa.ps1
\`\`\`

Exit code: 0
`;

    const result = validateQaEvidence(body);
    expect(result.valid).toBe(false);
    expect(result.problems).toContain("QA Evidence still contains host-system paths.");
  });

  it("rejects lowercase secret leakage in QA Evidence", () => {
    const body = `## QA Evidence

\`\`\`
token: abc123
\`\`\`

Exit code: 0
`;

    const result = validateQaEvidence(body);
    expect(result.valid).toBe(false);
    expect(result.problems).toContain("QA Evidence still contains secrets or environment values.");
  });

  it("strips existing QA Evidence sections before reappending", () => {
    const body = `## Summary

Hi

## QA Evidence

\`\`\`
old
\`\`\`

Exit code: 127

## Changes

- x
`;

    expect(stripQaEvidenceSections(body)).not.toContain("## QA Evidence");
    expect(stripQaEvidenceSections(body)).toContain("## Changes");
  });

  it("formats reviewer failures against the PR body only", () => {
    const validation = validateQaEvidence("## Summary\n\nNo QA section here.");
    expect(formatQaEvidenceValidationFailure(validation, "reviewer")).toContain(
      "Cannot approve review with invalid QA Evidence in the PR body.",
    );
    expect(formatQaEvidenceValidationFailure(validation, "reviewer")).toContain(
      'Reject the PR and instruct the developer to replace the existing "## QA Evidence" section in the PR body',
    );
  });
});
