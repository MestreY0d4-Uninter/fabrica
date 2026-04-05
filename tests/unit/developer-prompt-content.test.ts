import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEVELOPER_PROMPT_PATH = join(__dirname, "../../defaults/fabrica/prompts/developer.md");
const TESTER_PROMPT_PATH = join(__dirname, "../../defaults/fabrica/prompts/tester.md");
const ARCHITECT_PROMPT_PATH = join(__dirname, "../../defaults/fabrica/prompts/architect.md");

describe("developer prompt anti-pattern checklist", () => {
  let content: string;
  let testerContent: string;
  let architectContent: string;
  let reviewerContent: string;

  function getSection(content: string, heading: string): string {
    const start = content.indexOf(heading);
    if (start < 0) return "";

    const nextHeading = content.indexOf("\n## ", start + heading.length);
    return nextHeading < 0 ? content.slice(start) : content.slice(start, nextHeading);
  }

  beforeAll(() => {
    content = readFileSync(DEVELOPER_PROMPT_PATH, "utf8");
    testerContent = readFileSync(TESTER_PROMPT_PATH, "utf8");
    architectContent = readFileSync(ARCHITECT_PROMPT_PATH, "utf8");
    reviewerContent = readFileSync(
      join(__dirname, "../../defaults/fabrica/prompts/reviewer.md"),
      "utf8",
    );
  });

  it("contains anti-pattern checklist heading", () => {
    expect(content).toContain("Anti-Pattern Checklist");
  });

  it("contains canonical final result lines instead of mandatory work_finish instructions", () => {
    expect(content).toContain("Work result: DONE");
    expect(content).toContain("Work result: BLOCKED");
    expect(content).not.toContain("Always call work_finish");
  });

  it("contains QA Contract section requiring all 5 gates", () => {
    expect(content).toContain("qa.sh");
    expect(content).toContain("lint");
    expect(content).toContain("coverage");
  });

  it("contains QA Evidence PR body instruction", () => {
    expect(content).toContain("QA Evidence");
  });

  it("keeps tester and architect prompts aligned to canonical lifecycle result lines", () => {
    expect(testerContent).toContain("Test result: PASS");
    expect(testerContent).toContain("Test result: FAIL_INFRA");
    expect(testerContent).toContain("Test result: REFINE");
    expect(testerContent).toContain("Test result: BLOCKED");
    expect(testerContent).not.toContain("work_finish");

    expect(architectContent).toContain("Architecture result: DONE");
    expect(architectContent).toContain("Architecture result: BLOCKED");
    expect(architectContent).not.toContain("work_finish");
  });

  it("requires the execution contract in every worker prompt", () => {
    const prompts = [
      { role: "developer", content },
      { role: "tester", content: testerContent },
      { role: "reviewer", content: reviewerContent },
      { role: "architect", content: architectContent },
    ] as const;

    for (const { role, content: promptContent } of prompts) {
      const executionContract = getSection(promptContent, "## Execution Contract");

      expect(executionContract).toContain("nested coding agents");
      expect(executionContract).toContain("planning or meta-skills");
      expect(executionContract).toContain("another coding agent");
      expect(executionContract).toMatch(/Do not leave the assigned worktree execution path\./);

      if (role === "reviewer") {
        expect(executionContract).toContain("execute the review directly");
        expect(executionContract).toContain("Keep review verdict semantics pure");
        expect(executionContract).toContain("Review result: APPROVE");
        expect(executionContract).toContain("Review result: REJECT");
      } else {
        expect(executionContract).toContain("execute the task directly");
        expect(executionContract).toMatch(/canonical blocked result line/i);
      }
    }
  });

  it("keeps the reviewer prompt on the supported APPROVE or REJECT contract", () => {
    const reviewerExecutionContract = getSection(reviewerContent, "## Execution Contract");
    const reviewerTaskCompletion = getSection(reviewerContent, "## Task Completion");

    expect(reviewerExecutionContract).toContain("execute the review directly");
    expect(reviewerExecutionContract).toContain("Keep review verdict semantics pure");
    expect(reviewerExecutionContract).toContain("Review result: APPROVE");
    expect(reviewerExecutionContract).toContain("Review result: REJECT");
    expect(reviewerExecutionContract).not.toContain("do not emit a `Review result` line");
    expect(reviewerExecutionContract).not.toContain("blocked result line");

    expect(reviewerTaskCompletion).toContain("Review result: APPROVE");
    expect(reviewerTaskCompletion).toContain("Review result: REJECT");
    expect(reviewerTaskCompletion).not.toContain("do not emit a `Review result` line");
    expect(reviewerTaskCompletion).not.toContain("blocked result line");
  });

  it("keeps the developer workflow aligned with reusing the assigned worktree", () => {
    const worktreeWorkflow = getSection(content, "### 1. Use the assigned worktree");

    expect(worktreeWorkflow).toContain("assigned worktree");
    expect(worktreeWorkflow).toContain("reuse it");
    expect(worktreeWorkflow).toContain("verify it's clean");
    expect(worktreeWorkflow).toContain("Repo:` / `Execution path:`");
    expect(worktreeWorkflow).toContain("Work result: BLOCKED");
    expect(worktreeWorkflow).toContain("~/.openclaw/workspace/<slug>");
    expect(worktreeWorkflow).not.toContain("fresh worktree");
  });

  it("keeps the tester workflow aligned with the dedicated worktree path", () => {
    const branchWorkflow = getSection(testerContent, "### 1. Open the PR branch in its dedicated worktree");

    expect(branchWorkflow).toContain("dedicated worktree");
    expect(branchWorkflow).toMatch(/git -C "\$REPO_ROOT" remote get-url origin/);
    expect(branchWorkflow).toMatch(/git -C "\$REPO_ROOT" worktree add/);
    expect(branchWorkflow).toMatch(/git -C "\$REPO_ROOT" fetch origin/);
    expect(branchWorkflow).toContain("cd \"$WORKTREE\"");
    expect(branchWorkflow).toMatch(/git -C "\$REPO_ROOT" checkout main/);
    expect(branchWorkflow).toMatch(/git -C "\$REPO_ROOT" pull origin main/);
    expect(branchWorkflow).toMatch(/do not use the main checkout/i);
    expect(branchWorkflow).not.toContain("git checkout \"$PR_BRANCH\"");
  });
});
