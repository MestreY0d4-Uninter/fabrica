import { describe, expect, it } from "vitest";
import { TestProvider } from "../../lib/testing/test-provider.js";
import type { RunCommand } from "../../lib/context.js";
import { getCanonicalQaEvidenceValidationForPr, validatePrExistsForDeveloper } from "../../lib/tools/worker/work-finish.js";

describe("work_finish QA/reviewer contract", () => {
  it("accepts reviewer approval when the PR body has valid QA Evidence", async () => {
    const provider = new TestProvider();
    provider.setPrStatus(25, {
      state: "open",
      url: "https://example.com/pr/25",
      body: `## Summary

Looks good.

## QA Evidence

### lint
ruff check . — 0 errors

### types
mypy src/ — Success: no issues found

### security
pip-audit — No known vulnerabilities found

### tests
pytest — 12 passed

### coverage
coverage: 85.0%

Exit code: 0
`,
    });

    const validation = await getCanonicalQaEvidenceValidationForPr(provider, 25);
    expect(validation.valid).toBe(true);
    expect(validation.problems).toEqual([]);
  });

  it("uses the PR body only and ignores PR conversation comments as QA evidence", async () => {
    const provider = new TestProvider();
    provider.setPrStatus(25, {
      state: "open",
      url: "https://example.com/pr/25",
      body: `## Summary

No QA body yet.
`,
    });
    await provider.addPrConversationComment(25, `## QA Evidence

\`\`\`
bash scripts/qa.sh
\`\`\`

Exit code: 0
`);

    const validation = await getCanonicalQaEvidenceValidationForPr(provider, 25);
    expect(validation.valid).toBe(false);
    expect(validation.problems).toContain("PR body is missing a `## QA Evidence` section.");
  });

  it("fails closed when developer PR validation cannot verify provider state", async () => {
    const branchRunCommand: RunCommand = async (args) => {
      if (args[0] === "git" && args[1] === "branch" && args[2] === "--show-current") {
        return {
          stdout: "feature/42-fail-closed\n",
          stderr: "",
          exitCode: 0,
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        } as any;
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };

    const provider = new TestProvider();
    provider.findOpenPrForBranch = async () => null;
    provider.getPrStatus = async () => {
      throw new Error("provider offline");
    };

    await expect(
      validatePrExistsForDeveloper(
        42,
        "/fake/repo",
        provider,
        branchRunCommand,
        "/tmp/fabrica",
        "demo-project",
      ),
    ).rejects.toThrow(/verify PR state/i);
  });
});
