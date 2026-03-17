import { FABRICA_QUALITY_GATE_NAME } from "./quality-gate.js";
import { getGitHubRepoInstallationOctokit } from "./app-auth.js";

export type GitHubGovernanceResult = {
  attempted: boolean;
  requiredCheckConfigured: boolean;
  automergePrepared: boolean;
  mergeQueuePrepared: boolean;
  installationId?: number | null;
  skippedReason?: string;
};

export async function syncGitHubMergeGovernance(params: {
  pluginConfig?: Record<string, unknown>;
  owner: string;
  repo: string;
  branch: string;
  requiredApprovingReviewCount?: number;
  requireConversationResolution?: boolean;
  enableAutomerge?: boolean;
  enableMergeQueue?: boolean;
}): Promise<GitHubGovernanceResult> {
  const installation = await getGitHubRepoInstallationOctokit(params.pluginConfig, {
    owner: params.owner,
    repo: params.repo,
  });
  if (!installation?.octokit) {
    return {
      attempted: false,
      requiredCheckConfigured: false,
      automergePrepared: false,
      mergeQueuePrepared: false,
      skippedReason: "github_app_unavailable",
    };
  }

  const octokit = installation.octokit;
  await octokit.request("PUT /repos/{owner}/{repo}/branches/{branch}/protection", {
    owner: params.owner,
    repo: params.repo,
    branch: params.branch,
    required_status_checks: {
      strict: true,
      contexts: [FABRICA_QUALITY_GATE_NAME],
    },
    enforce_admins: false,
    required_pull_request_reviews: {
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
      required_approving_review_count: params.requiredApprovingReviewCount ?? 1,
      require_last_push_approval: false,
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: params.requireConversationResolution ?? true,
    required_linear_history: false,
  });

  if (params.enableAutomerge) {
    await octokit.request("PATCH /repos/{owner}/{repo}", {
      owner: params.owner,
      repo: params.repo,
      allow_auto_merge: true,
    });
  }

  // Merge queue still depends on repository rulesets/admin capabilities.
  // We surface the intent here so operators can wire the same gate name into
  // the repository ruleset when the feature is available.
  return {
    attempted: true,
    requiredCheckConfigured: true,
    automergePrepared: params.enableAutomerge === true,
    mergeQueuePrepared: params.enableMergeQueue === true,
    installationId: installation.installationId,
  };
}
