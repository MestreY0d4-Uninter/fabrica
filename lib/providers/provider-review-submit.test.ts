import { describe, it, vi } from "vitest";
import assert from "node:assert";
import type { RunCommand } from "../context.js";
import { GitHubProvider } from "./github.js";
import { PrState } from "./provider.js";

const mockRunCommand: RunCommand = async () => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
} as any);

describe("GitHubProvider.submitPrReview", () => {
  it("submits a formal review when GitHub App auth is available", async () => {
    const provider = new GitHubProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    (provider as any).getPrStatus = async () => ({
      state: PrState.OPEN,
      url: "https://github.com/test/repo/pull/7",
    });
    (provider as any).findOpenPrNumber = async () => 7;
    (provider as any).resolveInstallationAuth = async () => ({
      repo: { owner: "test", name: "repo" },
      installationId: 123,
      token: "token",
    });
    (provider as any).githubFetch = async () =>
      new Response(JSON.stringify({ id: 55, html_url: "https://github.com/test/repo/pull/7#pullrequestreview-55" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await provider.submitPrReview(42, {
      result: "reject",
      body: "Please fix the failing test coverage.",
    });

    assert.strictEqual(result.artifactType, "formal_review");
    assert.strictEqual(result.artifactId, 55);
    assert.strictEqual(result.usedFallback, false);
    assert.strictEqual(result.fallbackReason, undefined);
  });

  it("falls back to a PR conversation comment when formal review is unavailable", async () => {
    const provider = new GitHubProvider({ repoPath: "/fake", runCommand: mockRunCommand });
    const addPrConversationComment = vi.fn(async () => ({
      artifactId: 88,
      artifactType: "pr_conversation_comment" as const,
      prUrl: "https://github.com/test/repo/pull/7",
      usedFallback: false,
    }));

    (provider as any).getPrStatus = async () => ({
      state: PrState.OPEN,
      url: "https://github.com/test/repo/pull/7",
    });
    (provider as any).findOpenPrNumber = async () => 7;
    (provider as any).resolveInstallationAuth = async () => null;
    (provider as any).addPrConversationComment = addPrConversationComment;

    const result = await provider.submitPrReview(42, {
      result: "reject",
      body: "Please remove the leaked host path from the PR body.",
    });

    assert.strictEqual(addPrConversationComment.mock.calls.length, 1);
    assert.strictEqual(result.artifactType, "pr_conversation_comment");
    assert.strictEqual(result.artifactId, 88);
    assert.strictEqual(result.usedFallback, true);
    assert.strictEqual(result.fallbackReason, "github_app_unavailable");
  });

  it("records a structured fallback reason when formal review creation fails", async () => {
    const provider = new GitHubProvider({ repoPath: "/fake", runCommand: mockRunCommand });
    const addPrConversationComment = vi.fn(async () => ({
      artifactId: 89,
      artifactType: "pr_conversation_comment" as const,
      prUrl: "https://github.com/test/repo/pull/7",
      usedFallback: false,
      fallbackReason: "github_app_comment_failed",
    }));

    (provider as any).getPrStatus = async () => ({
      state: PrState.OPEN,
      url: "https://github.com/test/repo/pull/7",
    });
    (provider as any).findOpenPrNumber = async () => 7;
    (provider as any).resolveInstallationAuth = async () => ({
      repo: { owner: "test", name: "repo" },
      installationId: 123,
      token: "token",
    });
    (provider as any).githubFetch = async () =>
      new Response(JSON.stringify({ message: "unprocessable" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
    (provider as any).addPrConversationComment = addPrConversationComment;

    const result = await provider.submitPrReview(42, {
      result: "reject",
      body: "Fallback from failed formal review.",
    });

    assert.strictEqual(addPrConversationComment.mock.calls.length, 1);
    assert.strictEqual(result.artifactType, "pr_conversation_comment");
    assert.strictEqual(result.usedFallback, true);
    assert.strictEqual(result.fallbackReason, "formal_review_request_failed");
  });

  it("refuses to submit a review when the selected PR no longer targets the issue", async () => {
    const provider = new GitHubProvider({ repoPath: "/fake", runCommand: mockRunCommand });
    const addPrConversationComment = vi.fn();

    (provider as any).getPrStatus = async () => ({
      number: 10,
      state: PrState.OPEN,
      url: "https://github.com/test/repo/pull/10",
      linkedIssueIds: [11],
      currentIssueMatch: false,
    });
    (provider as any).findOpenPrNumber = async () => 10;
    (provider as any).addPrConversationComment = addPrConversationComment;

    await assert.rejects(
      provider.submitPrReview(42, {
        result: "reject",
        body: "This PR belongs to another issue.",
      }, { prNumber: 10 }),
      /No open PR found for issue #42/,
    );
    assert.strictEqual(addPrConversationComment.mock.calls.length, 0);
  });
});
