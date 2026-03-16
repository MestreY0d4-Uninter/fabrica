import type { PipelineArtifact } from "../types.js";

export type CleanupResult = {
  artifact: PipelineArtifact;
  action: "cleaned" | "dry_run" | "needs_manual_cleanup" | "failed";
  detail?: string;
};

export type CleanupOpts = {
  log: (msg: string) => void;
  dryRun: boolean;
};

export async function cleanupArtifacts(
  artifacts: PipelineArtifact[],
  opts: CleanupOpts,
): Promise<CleanupResult[]> {
  const results: CleanupResult[] = [];

  for (const artifact of artifacts) {
    opts.log(`[cleanup] ${opts.dryRun ? "(dry-run) " : ""}${artifact.type}: ${artifact.id}`);

    if (opts.dryRun) {
      results.push({ artifact, action: "dry_run" });
      continue;
    }

    // Mark artifacts as needing manual cleanup and log for operator visibility.
    // Future: add handlers for github_repo (gh repo delete), github_issue (gh issue close), etc.
    results.push({
      artifact,
      action: "needs_manual_cleanup",
      detail: `Artifact ${artifact.type}:${artifact.id} created but pipeline failed. Manual cleanup required.`,
    });
  }

  return results;
}
