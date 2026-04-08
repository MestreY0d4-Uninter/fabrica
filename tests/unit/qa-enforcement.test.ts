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
TOTAL                                         82      1    99%
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
    expect(result.primarySubcause).toBe("qa_exit_codes_only");
  });

  it("rejects missing required gate sections", () => {
    const body = `## QA Evidence
### lint
ruff OK
Exit code: 0`;

    const result = validateQaEvidence(body);
    expect(result.errors).toContain("qa_gate_missing_types");
    expect(result.errors).toContain("qa_gate_missing_tests");
    expect(result.missingGates).toEqual(expect.arrayContaining(["types", "tests"]));
    expect(result.primarySubcause).toBe("qa_missing_required_gates");
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
TOTAL                                         50      20    60%
Exit code: 0`;

    const result = validateQaEvidence(body);
    expect(result.errors).toContain("qa_coverage_below_threshold_60");
    expect(result.primarySubcause).toBe("qa_coverage_below_threshold");
  });

  it("does not confuse test progress indicators with coverage", () => {
    const body = `## QA Evidence
\`\`\`text
--- Ruff lint ---
All checks passed!
--- Mypy ---
Success: no issues found in 3 source files
--- Tests ---
tests/test_main.py::test_one PASSED             [ 14%]
tests/test_main.py::test_two PASSED             [ 28%]
tests/test_main.py::test_three PASSED           [ 42%]
tests/test_main.py::test_four PASSED            [ 57%]
tests/test_main.py::test_five PASSED            [ 71%]
tests/test_main.py::test_six PASSED             [ 85%]
tests/test_main.py::test_seven PASSED           [100%]
--- Coverage (>=80%) ---
TOTAL                                         82      1    99%
Required test coverage of 80% reached. Total coverage: 98.78%
--- Secrets scan ---
No hardcoded secrets found
\`\`\`

Exit code: 0`;

    const result = validateQaEvidence(body);
    expect(result.errors).not.toContain("qa_coverage_below_threshold_14");
    expect(result.errors.filter(e => e.startsWith("qa_coverage_below_threshold"))).toHaveLength(0);
  });
});
