import { describe, it, expect, vi } from "vitest";
import { cleanupArtifacts, type CleanupOpts } from "../../lib/intake/lib/artifact-cleanup.js";
import type { PipelineArtifact } from "../../lib/intake/types.js";

const log = vi.fn();
const opts: CleanupOpts = { log, dryRun: false };

describe("cleanupArtifacts — real compensations", () => {
  it("processes artifacts in reverse order (most recent first)", async () => {
    const artifacts: PipelineArtifact[] = [
      { type: "github_repo", id: "org/repo-1" },
      { type: "github_issue", id: "42" },
    ];

    const results = await cleanupArtifacts(artifacts, opts);
    // Verify reverse order: issue first, then repo
    expect(results[0].artifact.type).toBe("github_issue");
    expect(results[1].artifact.type).toBe("github_repo");
  });

  it("returns needs_manual_cleanup for unhandled artifact types", async () => {
    const artifacts: PipelineArtifact[] = [
      { type: "github_repo", id: "org/repo" },
    ];
    const results = await cleanupArtifacts(artifacts, opts);
    // github_repo cleanup requires provider — falls back to needs_manual_cleanup
    expect(results[0].action).toBe("needs_manual_cleanup");
  });

  it("respects dry_run flag", async () => {
    const artifacts: PipelineArtifact[] = [
      { type: "github_issue", id: "5" },
    ];
    const results = await cleanupArtifacts(artifacts, { log, dryRun: true });
    expect(results[0].action).toBe("dry_run");
  });

  it("returns empty array for no artifacts", async () => {
    const results = await cleanupArtifacts([], opts);
    expect(results).toEqual([]);
  });
});
