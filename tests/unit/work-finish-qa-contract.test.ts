import { describe, expect, it } from "vitest";
import { TestProvider } from "../../lib/testing/test-provider.js";
import { getCanonicalQaEvidenceValidationForPr } from "../../lib/tools/worker/work-finish.js";

describe("work_finish QA/reviewer contract", () => {
  it("accepts reviewer approval when the PR body has valid QA Evidence", async () => {
    const provider = new TestProvider();
    provider.setPrStatus(25, {
      state: "open",
      url: "https://example.com/pr/25",
      body: `## Summary

Looks good.

## QA Evidence

\`\`\`
bash scripts/qa.sh
\`\`\`

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
});
