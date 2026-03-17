import { describe, it, expect } from "vitest";
import { validateQaEvidence } from "../../lib/tools/tasks/qa-evidence.js";

describe("validateQaEvidence — enhanced checks", () => {
  it("accepts valid evidence with all gates", () => {
    const body = `## QA Evidence
### lint
ruff check . — 0 errors
Exit code: 0

### types
mypy src/ — Success: no issues found
Exit code: 0

### security
pip-audit — No known vulnerabilities found
Exit code: 0

### tests
pytest — 12 passed
Exit code: 0

### coverage
coverage: 85.3%
Exit code: 0`;

    const result = validateQaEvidence(body);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects empty evidence section", () => {
    const result = validateQaEvidence("No QA section here");
    expect(result.errors).toContain("qa_evidence_missing");
  });

  it("rejects evidence with only exit codes (no real output)", () => {
    const body = `## QA Evidence
Exit code: 0
Exit code: 0
Exit code: 0
Exit code: 0
Exit code: 0`;

    const result = validateQaEvidence(body);
    expect(result.errors).toContain("qa_evidence_only_exit_codes");
  });

  it("rejects missing required gate sections", () => {
    const body = `## QA Evidence
### lint
ruff OK
Exit code: 0`;

    const result = validateQaEvidence(body);
    expect(result.errors).toContain("qa_gate_missing_types");
    expect(result.errors).toContain("qa_gate_missing_tests");
  });

  it("rejects coverage below threshold", () => {
    const body = `## QA Evidence
### lint
OK
### types
OK
### security
OK
### tests
OK
### coverage
coverage: 60.0%`;

    const result = validateQaEvidence(body);
    expect(result.errors).toContain("qa_coverage_below_threshold_60");
  });
});
