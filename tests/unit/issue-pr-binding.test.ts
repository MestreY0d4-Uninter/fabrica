import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RunCommand } from "../../lib/context.js";
import { validatePrExistsForDeveloper } from "../../lib/tools/worker/work-finish.js";
import { TestProvider } from "../../lib/testing/test-provider.js";
import { DATA_DIR } from "../../lib/setup/migrate-layout.js";

describe("issue/PR canonical binding", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "issue-pr-binding-"));
    await mkdir(join(tempDir, DATA_DIR, "log"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const branchRunCommand: RunCommand = async (args) => {
    if (args[0] === "git" && args[1] === "branch" && args[2] === "--show-current") {
      return {
        stdout: "feature/1-stack-cli-mvp\n",
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

  it("accepts the open PR from the current branch when it still targets the issue", async () => {
    const provider = new TestProvider();
    provider.branchPrs.set("feature/1-stack-cli-mvp", {
      number: 12,
      state: "open",
      url: "https://example.com/pr/12",
      body: `## Summary

Stack CLI MVP.

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
      sourceBranch: "feature/1-stack-cli-mvp",
      linkedIssueIds: [1],
      currentIssueMatch: true,
    });

    const status = await validatePrExistsForDeveloper(
      1,
      "/fake/repo",
      provider,
      branchRunCommand,
      tempDir,
      "demo-project",
    );

    expect(status.number).toBe(12);
    expect(status.url).toBe("https://example.com/pr/12");
    expect(provider.callsTo("findOpenPrForBranch")).toHaveLength(1);
  });

  it("rejects a branch PR that was retargeted to another issue", async () => {
    const provider = new TestProvider();
    provider.branchPrs.set("feature/1-stack-cli-mvp", {
      number: 10,
      state: "open",
      url: "https://example.com/pr/10",
      sourceBranch: "feature/1-stack-cli-mvp",
      linkedIssueIds: [11],
      currentIssueMatch: false,
    });

    await expect(() => validatePrExistsForDeveloper(
      1,
      "/fake/repo",
      provider,
      branchRunCommand,
      tempDir,
      "demo-project",
    )).rejects.toThrow(/no longer targets issue #1/i);
  });

  it("rejects a branch PR that only matches by branch naming and has no explicit issue ref", async () => {
    const provider = new TestProvider();
    provider.branchPrs.set("feature/1-stack-cli-mvp", {
      number: 13,
      state: "open",
      url: "https://example.com/pr/13",
      sourceBranch: "feature/1-stack-cli-mvp",
      linkedIssueIds: [],
      branchIssueIds: [1],
      currentIssueMatch: false,
    });

    await expect(() => validatePrExistsForDeveloper(
      1,
      "/fake/repo",
      provider,
      branchRunCommand,
      tempDir,
      "demo-project",
    )).rejects.toThrow(/branch-only refs are not accepted as canonical ownership/i);
  });
});
