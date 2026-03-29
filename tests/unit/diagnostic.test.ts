import { describe, it, expect, vi, beforeEach } from "vitest";
import { diagnoseStall } from "../../lib/services/heartbeat/diagnostic.js";

// Mock child_process.execFileSync for gh CLI calls
const mockExecFileSync = vi.fn();
vi.mock("child_process", () => ({ execFileSync: (...args: any[]) => mockExecFileSync(...args) }));

describe("diagnoseStall", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns transition_to_review when PR exists and QA passes", async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("list")) return JSON.stringify([{ number: 42 }]);
      if (args.includes("view")) return JSON.stringify({ statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }] });
      return "[]";
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
    expect(result.prNumber).toBe(42);
  });

  it("returns log_infra when session is dead with zero artifacts", async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("not found"); });

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
    mockExecFileSync.mockImplementation(() => { throw new Error("not found"); });

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
    mockExecFileSync.mockImplementation(() => { throw new Error("not found"); });

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
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("list")) return JSON.stringify([{ number: 42 }]);
      if (args.includes("view")) return JSON.stringify({ statusCheckRollup: [{ conclusion: "FAILURE", status: "COMPLETED" }] });
      return "[]";
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
    expect(result.prNumber).toBe(42);
  });

  it("returns nudge_open_pr when branch has commits but no PR", async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("list")) return "[]"; // no PR
      return "abc123"; // has commits
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
