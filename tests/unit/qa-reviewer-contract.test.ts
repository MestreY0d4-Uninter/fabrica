import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const reviewerPrompt = readFileSync(
  new URL("../../defaults/fabrica/prompts/reviewer.md", import.meta.url),
  "utf-8",
);
const developerPrompt = readFileSync(
  new URL("../../defaults/fabrica/prompts/developer.md", import.meta.url),
  "utf-8",
);

describe("QA/reviewer prompt contract", () => {
  it("keeps reviewer QA evidence canonical to the PR body", () => {
    expect(reviewerPrompt).toContain("PR description body only");
    expect(reviewerPrompt).toContain("Do **not** use PR conversation comments or issue comments as QA evidence");
    expect(reviewerPrompt).not.toContain("PR conversation comments** as fallback");
    expect(reviewerPrompt).not.toContain("stale");
  });

  it("tells developers that PR comments are not canonical QA evidence", () => {
    expect(developerPrompt).toContain("The only additional section allowed in the PR body is the canonical `## QA Evidence` section");
    expect(developerPrompt).toContain("PR comments are not canonical QA evidence");
    expect(developerPrompt).not.toContain("Do NOT add sections** beyond Summary, Changes, and Security Checklist. QA Evidence is added separately");
  });
});
