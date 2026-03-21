import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PipelineArtifact } from "../types.js";

const execFileAsync = promisify(execFile);

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
 * Parse a GitHub repo URL or "owner/name" slug into { owner, name }.
 * Returns null if the string cannot be parsed.
 */
function parseRepoId(id: string): { owner: string; name: string } | null {
  // Full URL: https://github.com/owner/repo or https://github.com/owner/repo.git
  try {
    const url = new URL(id);
    const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      return { owner: parts[0], name: parts[1] };
    }
  } catch {
    // Not a URL — try "owner/name" slug
  }
  const parts = id.split("/");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { owner: parts[0], name: parts[1] };
  }
  return null;
}

/**
 * Parse a github_issue artifact id.
 * Accepts composite format "owner/repo#42" or plain number "42".
 * Returns null when repo context is unavailable (plain number only).
 */
function parseIssueId(
  id: string,
): { owner: string; repo: string; issueNumber: number } | null {
  const composite = id.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (composite) {
    return {
      owner: composite[1],
      repo: composite[2],
      issueNumber: Number(composite[3]),
    };
  }
  return null;
}

/**
 * Compensating actions per artifact type.
 * Returns true if compensation succeeded, false otherwise.
 */
const COMPENSATION_HANDLERS: Record<
  string,
  (artifact: PipelineArtifact, log: (m: string) => void) => Promise<boolean>
> = {
  github_repo: async (artifact, log) => {
    const parsed = parseRepoId(artifact.id);
    if (!parsed) {
      log(`Cannot cleanup repo: cannot parse owner/name from artifact id "${artifact.id}"`);
      return false;
    }
    const { owner, name } = parsed;
    try {
      await execFileAsync("gh", ["repo", "delete", `${owner}/${name}`, "--yes"]);
      log(`Deleted orphaned repo: ${owner}/${name}`);
      return true;
    } catch (err) {
      log(`Failed to delete repo ${owner}/${name}: ${(err as Error).message}`);
      return false;
    }
  },

  github_issue: async (artifact, log) => {
    const parsed = parseIssueId(artifact.id);
    if (!parsed) {
      log(
        `Cannot cleanup issue: artifact id "${artifact.id}" does not contain repo context. ` +
          `Use composite format "owner/repo#<number>" to enable automatic cleanup.`,
      );
      return false;
    }
    const { owner, repo, issueNumber } = parsed;
    try {
      await execFileAsync("gh", [
        "issue",
        "close",
        String(issueNumber),
        "--repo",
        `${owner}/${repo}`,
        "--comment",
        "Closed by Fabrica cleanup: pipeline failed after issue creation",
      ]);
      log(`Closed orphaned issue #${issueNumber} in ${owner}/${repo}`);
      return true;
    } catch (err) {
      log(`Failed to close issue #${issueNumber}: ${(err as Error).message}`);
      return false;
    }
  },
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
