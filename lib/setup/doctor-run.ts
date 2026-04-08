import { readProjects, getIssueRuntime } from "../projects/index.js";
import { createProvider } from "../providers/index.js";
import type { RunCommand } from "../context.js";
import type { PrStatus } from "../providers/provider.js";

export type IssueRunDoctorResult = {
  projectSlug: string;
  projectName: string;
  issueId: number;
  issueRuntime: Record<string, unknown> | null;
  hasArtifact: boolean;
  convergence: {
    cause: string | null;
    action: string | null;
    retryCount: number;
    reason: string | null;
    at: string | null;
  };
  pr: {
    url: string | null;
    state: string | null;
    number: number | null;
    mergeable: boolean | null;
    currentIssueMatch: boolean | null;
    sourceBranch: string | null;
  } | null;
  issue: {
    url: string | null;
    state: string | null;
    labels: string[];
    title: string | null;
  } | null;
  recommendation: {
    summary: string;
    likelyNextAction: string;
  };
};

export async function runIssueDoctor(opts: {
  workspacePath: string;
  projectSlug: string;
  issueId: number;
  runCommand: RunCommand;
  pluginConfig?: Record<string, unknown>;
}): Promise<IssueRunDoctorResult> {
  const data = await readProjects(opts.workspacePath);
  const project = data.projects[opts.projectSlug];
  if (!project) throw new Error(`Project not found: ${opts.projectSlug}`);

  const issueRuntime = getIssueRuntime(project, opts.issueId) ?? null;
  const hasArtifact = Boolean(
    issueRuntime?.currentPrUrl ||
    issueRuntime?.currentPrNumber ||
    issueRuntime?.artifactOfRecord,
  );

  const { provider } = await createProvider({
    repo: project.repo,
    provider: project.provider,
    providerProfile: project.providerProfile,
    runCommand: opts.runCommand,
    pluginConfig: opts.pluginConfig,
  });

  let prStatus: PrStatus | null = null;
  try {
    const pr = await provider.getPrStatus(opts.issueId);
    if (pr.url || pr.number) prStatus = pr;
  } catch {
    prStatus = null;
  }

  let issue: Awaited<ReturnType<typeof provider.getIssue>> | null = null;
  try {
    issue = await provider.getIssue(opts.issueId);
  } catch {
    issue = null;
  }

  const convergenceCause = issueRuntime?.lastConvergenceCause ?? null;
  const convergenceAction = issueRuntime?.lastConvergenceAction ?? null;
  const retryCount = issueRuntime?.lastConvergenceRetryCount ?? 0;
  const convergenceReason = issueRuntime?.lastConvergenceReason ?? issueRuntime?.inconclusiveCompletionReason ?? null;

  const summaryParts = [
    hasArtifact ? "artifact_present" : "artifact_missing",
    convergenceCause ? `cause=${convergenceCause}` : "cause=none",
    convergenceAction ? `action=${convergenceAction}` : "action=none",
    retryCount ? `retries=${retryCount}` : "retries=0",
    prStatus?.state ? `pr=${prStatus.state}` : "pr=unknown",
  ];

  const likelyNextAction = (() => {
    if (convergenceAction === "escalate_human") return "human_intervention";
    if (convergenceCause === "invalid_qa_evidence") return "repair_qa_evidence";
    if (convergenceCause === "merge_conflict") return "repair_merge_conflict";
    if (convergenceCause === "stalled_with_artifact") return "force_convergence_review";
    if (hasArtifact) return "post_pr_convergence";
    return "redispatch_or_investigate";
  })();

  return {
    projectSlug: project.slug,
    projectName: project.name,
    issueId: opts.issueId,
    issueRuntime,
    hasArtifact,
    convergence: {
      cause: convergenceCause,
      action: convergenceAction,
      retryCount,
      reason: convergenceReason,
      at: issueRuntime?.lastConvergenceAt ?? null,
    },
    pr: prStatus
      ? {
          url: prStatus.url ?? null,
          state: prStatus.state ?? null,
          number: prStatus.number ?? null,
          mergeable: prStatus.mergeable ?? null,
          currentIssueMatch: prStatus.currentIssueMatch ?? null,
          sourceBranch: prStatus.sourceBranch ?? null,
        }
      : null,
    issue: issue
      ? {
          url: issue.web_url ?? null,
          state: issue.state ?? null,
          labels: issue.labels ?? [],
          title: issue.title ?? null,
        }
      : null,
    recommendation: {
      summary: summaryParts.join(" | "),
      likelyNextAction,
    },
  };
}

export function formatIssueDoctor(result: IssueRunDoctorResult): string {
  const lines = [
    `Issue run doctor — ${result.projectSlug}#${result.issueId}`,
    `  Artifact: ${result.hasArtifact ? "yes" : "no"}`,
    `  PR: ${result.pr?.url ?? "n/a"} (${result.pr?.state ?? "unknown"})`,
    `  Issue: ${result.issue?.url ?? "n/a"} (${result.issue?.state ?? "unknown"})`,
    `  Labels: ${result.issue?.labels?.join(", ") ?? "n/a"}`,
    `  Convergence cause: ${result.convergence.cause ?? "none"}`,
    `  Convergence action: ${result.convergence.action ?? "none"}`,
    `  Retry count: ${result.convergence.retryCount}`,
    `  Last reason: ${result.convergence.reason ?? "n/a"}`,
    `  Suggested next action: ${result.recommendation.likelyNextAction}`,
  ];
  return lines.join("\n");
}
