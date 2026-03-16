import { describe, it, expect, vi } from "vitest";
import { cleanupArtifacts } from "../../lib/intake/lib/artifact-cleanup.js";
import type { PipelineArtifact } from "../../lib/intake/types.js";

describe("cleanupArtifacts", () => {
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
