import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validatePrExistsForDeveloper } from "../../lib/tools/worker/work-finish.js";
import { TestProvider } from "../../lib/testing/test-provider.js";
import type { RunCommand } from "../../lib/context.js";

describe("validatePrExistsForDeveloper active regression coverage", () => {
  let tempDir: string;
  const validQaEvidence = `## QA Evidence

### lint
eslint . — 0 errors

### types
tsc --noEmit — ok

### security
npm audit — 0 vulnerabilities

### tests
vitest — 12 passed

### coverage
coverage: 85.0%

Exit code: 0`;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "work-finish-pr-validation-"));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const featureBranchRunCommand: RunCommand = async (args) => {
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

  const mainBranchRunCommand: RunCommand = async (args) => {
    if (args[0] === "git" && args[1] === "branch" && args[2] === "--show-current") {
      return {
        stdout: "main\n",
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

  const integrationBranchRunCommand: RunCommand = async (args) => {
    if (args[0] === "git" && args[1] === "branch" && args[2] === "--show-current") {
      return {
        stdout: "integration\n",
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

  it("accepts the issue-linked open PR when the checkout branch is main", async () => {
    const provider = new TestProvider();
    provider.setPrStatus(1, {
      number: 12,
      state: "open",
      url: "https://example.com/pr/12",
      sourceBranch: "feature/1-stack-cli-mvp",
      linkedIssueIds: [1],
      currentIssueMatch: true,
      body: validQaEvidence,
    });

    const status = await validatePrExistsForDeveloper(
      1,
      "/fake/repo",
      provider,
      mainBranchRunCommand,
      tempDir,
      "demo-project",
      undefined,
      "main",
    );

    assert.strictEqual(status.number, 12);
    assert.strictEqual(provider.callsTo("getPrStatus").length, 1);
    assert.strictEqual(provider.callsTo("findOpenPrForBranch").length, 0);
  });

  it("accepts the issue-linked open PR when the project base branch uses a custom name", async () => {
    const provider = new TestProvider();
    provider.setPrStatus(1, {
      number: 12,
      state: "open",
      url: "https://example.com/pr/12",
      sourceBranch: "feature/1-stack-cli-mvp",
      linkedIssueIds: [1],
      currentIssueMatch: true,
      body: validQaEvidence,
    });

    const status = await validatePrExistsForDeveloper(
      1,
      "/fake/repo",
      provider,
      integrationBranchRunCommand,
      tempDir,
      "demo-project",
      undefined,
      "integration",
    );

    assert.strictEqual(status.number, 12);
    assert.strictEqual(provider.callsTo("getPrStatus").length, 1);
    assert.strictEqual(provider.callsTo("findOpenPrForBranch").length, 0);
  });

  it("accepts the current branch PR when it is the canonical open PR for the issue", async () => {
    const provider = new TestProvider();
    provider.branchPrs.set("feature/1-stack-cli-mvp", {
      number: 12,
      state: "open",
      url: "https://example.com/pr/12",
      sourceBranch: "feature/1-stack-cli-mvp",
      linkedIssueIds: [1],
      currentIssueMatch: true,
      body: validQaEvidence,
    });

    const status = await validatePrExistsForDeveloper(
      1,
      "/fake/repo",
      provider,
      featureBranchRunCommand,
      tempDir,
      "demo-project",
    );

    assert.strictEqual(status.number, 12);
    assert.strictEqual(provider.callsTo("getPrStatus").length, 1);
    assert.strictEqual(provider.callsTo("findOpenPrForBranch").length, 1);
  });

  it("rejects a retargeted branch PR even if another open issue-linked PR exists", async () => {
    const provider = new TestProvider();
    provider.branchPrs.set("feature/1-stack-cli-mvp", {
      number: 10,
      state: "open",
      url: "https://example.com/pr/10",
      sourceBranch: "feature/1-stack-cli-mvp",
      linkedIssueIds: [11],
      currentIssueMatch: false,
      body: "## QA Evidence\n- wrong pr",
    });
    provider.setPrStatus(1, {
      number: 12,
      state: "open",
      url: "https://example.com/pr/12",
      sourceBranch: "feature/other-branch",
      linkedIssueIds: [1],
      currentIssueMatch: true,
      body: validQaEvidence,
    });

    await assert.rejects(
      () => validatePrExistsForDeveloper(
        1,
        "/fake/repo",
        provider,
        featureBranchRunCommand,
        tempDir,
        "demo-project",
      ),
      /no longer targets issue #1/i,
    );
  });
});
