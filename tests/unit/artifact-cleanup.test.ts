import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanupArtifacts } from "../../lib/intake/lib/artifact-cleanup.js";
import type { PipelineArtifact } from "../../lib/intake/types.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";

// Helper: make execFile resolve successfully (promisify wraps the callback style)
function mockExecFileSuccess() {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], callback: (err: null, stdout: string, stderr: string) => void) => {
      callback(null, "", "");
    },
  );
}

// Helper: make execFile reject with an error
function mockExecFileFailure(message: string) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], callback: (err: Error) => void) => {
      callback(new Error(message));
    },
  );
}

describe("cleanupArtifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty results for empty artifact list", async () => {
    const results = await cleanupArtifacts([], { log: vi.fn(), dryRun: false });
    expect(results).toEqual([]);
  });

  it("logs cleanup actions for each artifact", async () => {
    const log = vi.fn();
    const artifacts: PipelineArtifact[] = [
      { type: "github_repo", id: "org/repo" },
      { type: "github_issue", id: "org/repo#1" },
    ];
    const results = await cleanupArtifacts(artifacts, { log, dryRun: true });
    expect(log).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.action === "dry_run")).toBe(true);
  });

  it("marks artifacts as needs_manual_cleanup when no handler available", async () => {
    const artifacts: PipelineArtifact[] = [
      { type: "forum_topic", id: "topic-123" },
    ];
    const results = await cleanupArtifacts(artifacts, { log: vi.fn(), dryRun: false });
    expect(results[0].action).toBe("needs_manual_cleanup");
  });
});

describe("COMPENSATION_HANDLERS — github_repo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns cleaned when gh repo delete succeeds (full URL)", async () => {
    mockExecFileSuccess();
    const artifacts: PipelineArtifact[] = [
      { type: "github_repo", id: "https://github.com/myorg/myrepo" },
    ];
    const results = await cleanupArtifacts(artifacts, { log: vi.fn(), dryRun: false });
    expect(results[0].action).toBe("cleaned");
  });

  it("returns cleaned when gh repo delete succeeds (owner/name slug)", async () => {
    mockExecFileSuccess();
    const artifacts: PipelineArtifact[] = [
      { type: "github_repo", id: "myorg/myrepo" },
    ];
    const results = await cleanupArtifacts(artifacts, { log: vi.fn(), dryRun: false });
    expect(results[0].action).toBe("cleaned");
  });

  it("calls gh repo delete with correct args", async () => {
    mockExecFileSuccess();
    const artifacts: PipelineArtifact[] = [
      { type: "github_repo", id: "https://github.com/testorg/testrepo" },
    ];
    await cleanupArtifacts(artifacts, { log: vi.fn(), dryRun: false });
    const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("gh");
    expect(calls[0][1]).toEqual(["repo", "delete", "testorg/testrepo", "--yes"]);
  });

  it("returns needs_manual_cleanup when id cannot be parsed", async () => {
    const log = vi.fn();
    const artifacts: PipelineArtifact[] = [
      { type: "github_repo", id: "not-a-valid-id" },
    ];
    const results = await cleanupArtifacts(artifacts, { log, dryRun: false });
    expect(results[0].action).toBe("needs_manual_cleanup");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Cannot cleanup repo"));
  });

  it("returns needs_manual_cleanup and logs on gh failure", async () => {
    mockExecFileFailure("Repository not found");
    const log = vi.fn();
    const artifacts: PipelineArtifact[] = [
      { type: "github_repo", id: "myorg/myrepo" },
    ];
    const results = await cleanupArtifacts(artifacts, { log, dryRun: false });
    expect(results[0].action).toBe("needs_manual_cleanup");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Repository not found"));
  });
});

describe("COMPENSATION_HANDLERS — github_issue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns cleaned when gh issue close succeeds (composite id)", async () => {
    mockExecFileSuccess();
    const artifacts: PipelineArtifact[] = [
      { type: "github_issue", id: "myorg/myrepo#42" },
    ];
    const results = await cleanupArtifacts(artifacts, { log: vi.fn(), dryRun: false });
    expect(results[0].action).toBe("cleaned");
  });

  it("calls gh issue close with correct args", async () => {
    mockExecFileSuccess();
    const artifacts: PipelineArtifact[] = [
      { type: "github_issue", id: "testorg/testrepo#7" },
    ];
    await cleanupArtifacts(artifacts, { log: vi.fn(), dryRun: false });
    const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("gh");
    expect(calls[0][1]).toContain("issue");
    expect(calls[0][1]).toContain("close");
    expect(calls[0][1]).toContain("7");
    expect(calls[0][1]).toContain("testorg/testrepo");
  });

  it("returns needs_manual_cleanup when id is plain number (no repo context)", async () => {
    const log = vi.fn();
    const artifacts: PipelineArtifact[] = [
      { type: "github_issue", id: "42" },
    ];
    const results = await cleanupArtifacts(artifacts, { log, dryRun: false });
    expect(results[0].action).toBe("needs_manual_cleanup");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Cannot cleanup issue"));
  });

  it("returns needs_manual_cleanup and logs on gh failure", async () => {
    mockExecFileFailure("Issue not found");
    const log = vi.fn();
    const artifacts: PipelineArtifact[] = [
      { type: "github_issue", id: "myorg/myrepo#99" },
    ];
    const results = await cleanupArtifacts(artifacts, { log, dryRun: false });
    expect(results[0].action).toBe("needs_manual_cleanup");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Issue not found"));
  });
});
