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

/**
 * Compensating actions per artifact type.
 * Returns true if compensation succeeded, false otherwise.
 * Provider-dependent actions (repo delete, issue close) require CLI calls
 * that aren't available here — they fall through to needs_manual_cleanup.
 */
const COMPENSATION_HANDLERS: Record<
  string,
  (artifact: PipelineArtifact, log: (m: string) => void) => Promise<boolean>
> = {
  // Future: add gh repo delete, gh issue close handlers here
  // For now, all types fall through to needs_manual_cleanup
};

export async function cleanupArtifacts(
  artifacts: PipelineArtifact[],
  opts: CleanupOpts,
): Promise<CleanupResult[]> {
  const results: CleanupResult[] = [];

  // Process in reverse order (most recently created first) — saga compensation pattern
  const reversed = [...artifacts].reverse();

  for (const artifact of reversed) {
    opts.log(`[cleanup] ${opts.dryRun ? "(dry-run) " : ""}${artifact.type}: ${artifact.id}`);

    if (opts.dryRun) {
      results.push({ artifact, action: "dry_run" });
      continue;
    }

    const handler = COMPENSATION_HANDLERS[artifact.type];
    if (handler) {
      try {
        const success = await handler(artifact, opts.log);
        results.push({
          artifact,
          action: success ? "cleaned" : "needs_manual_cleanup",
          detail: success
            ? `Compensated ${artifact.type}:${artifact.id}`
            : `Compensation failed for ${artifact.type}:${artifact.id}`,
        });
        continue;
      } catch (err) {
        results.push({
          artifact,
          action: "needs_manual_cleanup",
          detail: `Compensation threw for ${artifact.type}:${artifact.id}: ${String(err)}`,
        });
        continue;
      }
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
