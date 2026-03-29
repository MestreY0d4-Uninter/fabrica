import { describe, it, expect, vi, beforeEach } from "vitest";
import { diagnoseStall } from "../../lib/services/heartbeat/diagnostic.js";

// Mock execa for gh CLI calls
const mockExeca = vi.fn();
vi.mock("execa", () => ({ execa: (...args: any[]) => mockExeca(...args) }));

describe("diagnoseStall", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns transition_to_review when PR exists and QA passes", async () => {
    // gh pr list returns a PR
    mockExeca.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes("pr") && args.includes("list")) {
        return { stdout: JSON.stringify([{ number: 42 }]) };
      }
      if (args.includes("pr") && args.includes("checks")) {
        return { stdout: JSON.stringify([{ state: "SUCCESS" }]) };
      }
      return { stdout: "[]" };
    });

    const result = await diagnoseStall({
      projectSlug: "myproject",
      owner: "org", repo: "repo",
      issueId: 1,
      sessionKey: "agent:main:subagent:myproject-developer-junior-ada",
      slotStartTime: Date.now() - 3600000,
      sessionUpdatedAt: Date.now() - 2700000,
    });
    expect(result.action).toBe("transition_to_review");
  });

  it("returns log_infra when session is dead with zero artifacts", async () => {
    mockExeca.mockRejectedValue(new Error("not found"));

    const result = await diagnoseStall({
      projectSlug: "myproject",
      owner: "org", repo: "repo",
      issueId: 1,
      sessionKey: "agent:main:subagent:myproject-developer-junior-ada",
      slotStartTime: Date.now() - 3600000,
      sessionUpdatedAt: Date.now() - 3600000, // 60 min idle = dead
    });
    expect(result.action).toBe("log_infra");
    expect(result.reason).toBe("infra");
  });

  it("returns escalate_level when session active but no commits", async () => {
    mockExeca.mockRejectedValue(new Error("not found"));

    const result = await diagnoseStall({
      projectSlug: "myproject",
      owner: "org", repo: "repo",
      issueId: 1,
      sessionKey: "agent:main:subagent:myproject-developer-junior-ada",
      slotStartTime: Date.now() - 600000,
      sessionUpdatedAt: Date.now() - 60000, // 1 min idle = still active
    });
    expect(result.action).toBe("escalate_level");
    expect(result.reason).toBe("complexity");
  });

  it("returns needs_human_review when same stall 2x+ without artifacts", async () => {
    mockExeca.mockRejectedValue(new Error("not found"));

    const result = await diagnoseStall({
      projectSlug: "myproject",
      owner: "org", repo: "repo",
      issueId: 1,
      sessionKey: "agent:main:subagent:myproject-developer-junior-ada",
      slotStartTime: Date.now() - 3600000,
      sessionUpdatedAt: Date.now() - 3600000,
      dispatchAttemptCount: 2,
    });
    expect(result.action).toBe("needs_human_review");
  });

  it("returns redispatch_same_level when PR exists but QA fails", async () => {
    mockExeca.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes("list")) return { stdout: JSON.stringify([{ number: 42 }]) };
      if (args.includes("checks")) return { stdout: JSON.stringify([{ state: "FAILURE" }]) };
      return { stdout: "[]" };
    });

    const result = await diagnoseStall({
      projectSlug: "myproject",
      owner: "org", repo: "repo",
      issueId: 1,
      sessionKey: "agent:main:subagent:myproject-developer-junior-ada",
      slotStartTime: Date.now() - 3600000,
      sessionUpdatedAt: Date.now() - 2700000,
    });
    expect(result.action).toBe("redispatch_same_level");
  });

  it("returns nudge_open_pr when branch has commits but no PR", async () => {
    mockExeca.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes("list")) return { stdout: "[]" }; // no PR
      // checkForBranchCommits or checkForArtifacts — returns something
      return { stdout: "abc123" }; // has commits
    });

    const result = await diagnoseStall({
      projectSlug: "myproject",
      owner: "org", repo: "repo",
      issueId: 1,
      sessionKey: "agent:main:subagent:myproject-developer-junior-ada",
      slotStartTime: Date.now() - 3600000,
      sessionUpdatedAt: Date.now() - 2700000,
    });
    expect(result.action).toBe("nudge_open_pr");
  });
});
