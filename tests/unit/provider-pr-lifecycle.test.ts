import { describe, expect, it } from "vitest";
import type { RunCommand } from "../../lib/context.js";
import { GitHubProvider } from "../../lib/providers/github.js";
import { PrState } from "../../lib/providers/provider.js";

const mockRunCommand: RunCommand = async () => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
} as any);

describe("provider PR lifecycle semantics", () => {
  it("treats a selector-bound GitHub PR that is merged and previously approved as MERGED", async () => {
    const provider = new GitHubProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    (provider as any).gh = async () => JSON.stringify({
      id: "PR_kwDOAA",
      number: 17,
      title: "feat: canonical merge",
      body: "Addresses #42",
      headRefName: "feature/42-canonical-merge",
      url: "https://github.com/acme/demo/pull/17",
      state: "closed",
      mergedAt: "2026-03-31T00:00:00Z",
      reviewDecision: "APPROVED",
      mergeable: true,
    });

    const status = await provider.getPrStatus(42, { prNumber: 17 });

    expect(status.state).toBe(PrState.MERGED);
    expect(status.url).toBe("https://github.com/acme/demo/pull/17");
  });

  it("treats the most recent merged GitHub PR as MERGED even when it was approved before merge", async () => {
    const provider = new GitHubProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    (provider as any).findPrsForIssue = async (_issueId: number, state: string) => {
      if (state === "open") return [];
      if (state === "merged") {
        return [
          {
            number: 17,
            title: "feat: canonical merge",
            body: "Addresses #42",
            headRefName: "feature/42-canonical-merge",
            url: "https://github.com/acme/demo/pull/17",
            reviewDecision: "APPROVED",
            mergedAt: "2026-03-31T00:00:00Z",
          },
        ];
      }
      return [];
    };
    (provider as any).findPrsViaTimeline = async () => null;

    const status = await provider.getPrStatus(42);

    expect(status.state).toBe(PrState.MERGED);
    expect(status.url).toBe("https://github.com/acme/demo/pull/17");
  });
});
