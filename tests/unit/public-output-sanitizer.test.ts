import { describe, it, expect } from "vitest";
import { findPublicOutputViolations } from "../../lib/tools/tasks/public-output-sanitizer.js";

describe("public-output-sanitizer — QA-7 regression", () => {
  describe("should NOT flag legitimate QA output as secrets", () => {
    const legitimateOutputs = [
      "tests=47",
      "coverage=98%",
      "ruff check --select=E501",
      "mypy --strict --python-version=3.12",
      "exit_code=0",
      "pip-audit --fix --dry-run",
      "PASS tests/test_converter.py::test_celsius_to_fahrenheit",
      "All 8 checks passed",
      'python -m pytest --cov=src --cov-report=term-missing',
    ];

    for (const output of legitimateOutputs) {
      it(`"${output}" should not be flagged as secret`, () => {
        const violations = findPublicOutputViolations(output);
        expect(violations).not.toContain("secret");
      });
    }
  });

  describe("should still flag real secrets", () => {
    const realSecrets = [
      "ghp_abc123def456ghi789",
      "sk-proj-abc123def456",
      "AKIA1234567890ABCDEF",
      "token=ghp_abc123def456",
      "authorization: Bearer sk-abc123",
      "password=my_super_secret_password",
      "api_key=AIzaSyABC123DEF",
      "xoxb-123456789-abcdefgh",
      "glpat-abc123def456",
    ];

    for (const secret of realSecrets) {
      it(`"${secret}" should be flagged as secret`, () => {
        const violations = findPublicOutputViolations(secret);
        expect(violations).toContain("secret");
      });
    }
  });
});
