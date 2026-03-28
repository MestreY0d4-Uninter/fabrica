import { FABRICA_QUALITY_GATE_NAME as _FABRICA_QUALITY_GATE_NAME } from "./quality-gate.js";

export type GitHubGovernanceResult = {
  attempted: boolean;
  requiredCheckConfigured: boolean;
  automergePrepared: boolean;
  mergeQueuePrepared: boolean;
  installationId?: number | null;
  skippedReason?: string;
};

/**
 * GitHub App removed (distribution concern). Governance requires manual branch
 * protection setup. This function is intentionally a no-op.
 *
 * To configure merge governance manually, set the following branch protection rules
 * for your default branch in GitHub Settings > Branches:
 *   - Required status checks: "Fabrica / Quality Gate"
 *   - Require conversation resolution
 *   - Required approving reviews: 1+
 */
export async function syncGitHubMergeGovernance(_params: {
  pluginConfig?: Record<string, unknown>;
  owner: string;
  repo: string;
  branch: string;
  requiredApprovingReviewCount?: number;
  requireConversationResolution?: boolean;
  enableAutomerge?: boolean;
  enableMergeQueue?: boolean;
}): Promise<GitHubGovernanceResult> {
  // GitHub App removed — branch protection must be configured manually.
  return {
    attempted: false,
    requiredCheckConfigured: false,
    automergePrepared: false,
    mergeQueuePrepared: false,
    skippedReason: "github_app_removed",
  };
}
