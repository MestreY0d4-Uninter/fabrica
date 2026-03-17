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

describe("GitHubProvider current issue targeting", () => {
  it("ignores a timeline-linked PR that now explicitly targets another issue", async () => {
    const provider = new GitHubProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    (provider as any).findPrsViaTimeline = async (_issueId: number, state: string) => {
      if (state !== "open") return [];
      return [
        {
          number: 10,
          title: "feat: add minimal healthcheck API endpoint (#11)",
          body: "Addresses issue #11.",
          headRefName: "feature/1-stack-cli-mvp",
          url: "https://github.com/owner/repo/pull/10",
          mergedAt: null,
          reviewDecision: null,
          state: "OPEN",
          mergeable: "MERGEABLE",
        },
      ];
    };
    (provider as any).gh = async () => JSON.stringify([]);

    const status = await provider.getPrStatus(1);

    expect(status.state).toBe(PrState.CLOSED);
    expect(status.url).toBeNull();
  });
});
