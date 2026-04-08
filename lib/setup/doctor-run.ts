import { readProjects, getIssueRuntime } from "../projects/index.js";
import { createProvider } from "../providers/index.js";
import type { RunCommand } from "../context.js";
import type { PrStatus } from "../providers/provider.js";

export type IssueRunDoctorResult = {
  projectSlug: string;
  projectName: string;
  stack: string | null;
  issueId: number;
  issueRuntime: Record<string, unknown> | null;
  hasArtifact: boolean;
  lifecycle: {
    dispatchCycleId: string | null;
    dispatchRunId: string | null;
    agentAcceptedAt: string | null;
    firstWorkerActivityAt: string | null;
    sessionCompletedAt: string | null;
    progressState: "no_dispatch" | "accepted_idle" | "active" | "completed";
  };
  convergence: {
    cause: string | null;
    qaSubcause: string | null;
    qaMissingGates: string[];
    action: string | null;
    retryCount: number;
    reason: string | null;
    at: string | null;
    headSha: string | null;
    headShaChangedSinceLastConvergence: boolean | null;
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
  const convergenceQaSubcause = issueRuntime?.lastQaSubcause ?? null;
  const convergenceQaMissingGates = issueRuntime?.lastQaMissingGates ?? [];
  const convergenceAction = issueRuntime?.lastConvergenceAction ?? null;
  const retryCount = issueRuntime?.lastConvergenceRetryCount ?? 0;
  const convergenceReason = issueRuntime?.lastConvergenceReason ?? issueRuntime?.inconclusiveCompletionReason ?? null;
  const convergenceHeadSha = issueRuntime?.lastConvergenceHeadSha ?? null;
  const currentHeadSha = issueRuntime?.currentPrHeadSha ?? issueRuntime?.lastHeadSha ?? prStatus?.sourceBranch ?? null;
  const headShaChangedSinceLastConvergence = convergenceHeadSha && currentHeadSha
    ? convergenceHeadSha !== currentHeadSha
    : null;
  const progressState = issueRuntime?.sessionCompletedAt
    ? "completed"
    : issueRuntime?.firstWorkerActivityAt
      ? "active"
      : issueRuntime?.agentAcceptedAt
        ? "accepted_idle"
        : "no_dispatch";

  const summaryParts = [
    hasArtifact ? "artifact_present" : "artifact_missing",
    convergenceCause ? `cause=${convergenceCause}` : "cause=none",
    convergenceAction ? `action=${convergenceAction}` : "action=none",
    retryCount ? `retries=${retryCount}` : "retries=0",
    prStatus?.state ? `pr=${prStatus.state}` : "pr=unknown",
  ];

  const likelyNextAction = (() => {
    if (convergenceAction === "escalate_human") return "human_intervention";
    if ([
      "invalid_qa_evidence",
      "qa_schema_missing",
      "qa_section_count_invalid",
      "qa_exit_code_missing",
      "qa_exit_code_nonzero",
      "qa_sanitization_failed",
      "qa_missing_required_gates",
      "qa_exit_codes_only",
      "qa_coverage_below_threshold",
      "qa_stale_or_unchanged",
    ].includes(convergenceCause ?? "")) return "repair_qa_evidence";
    if (convergenceCause === "merge_conflict") return "repair_merge_conflict";
    if (convergenceCause === "stalled_with_artifact") return "force_convergence_review";
    if (hasArtifact) return "post_pr_convergence";
    return "redispatch_or_investigate";
  })();

  return {
    projectSlug: project.slug,
    projectName: project.name,
    stack: project.stack ?? project.environment?.stack ?? null,
    issueId: opts.issueId,
    issueRuntime,
    hasArtifact,
    lifecycle: {
      dispatchCycleId: issueRuntime?.lastDispatchCycleId ?? null,
      dispatchRunId: issueRuntime?.dispatchRunId ?? null,
      agentAcceptedAt: issueRuntime?.agentAcceptedAt ?? null,
      firstWorkerActivityAt: issueRuntime?.firstWorkerActivityAt ?? null,
      sessionCompletedAt: issueRuntime?.sessionCompletedAt ?? null,
      progressState,
    },
    convergence: {
      cause: convergenceCause,
      qaSubcause: convergenceQaSubcause,
      qaMissingGates: convergenceQaMissingGates,
      action: convergenceAction,
      retryCount,
      reason: convergenceReason,
      at: issueRuntime?.lastConvergenceAt ?? null,
      headSha: convergenceHeadSha,
      headShaChangedSinceLastConvergence,
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
    `  Stack: ${result.stack ?? "unknown"}`,
    `  Artifact: ${result.hasArtifact ? "yes" : "no"}`,
    `  PR: ${result.pr?.url ?? "n/a"} (${result.pr?.state ?? "unknown"})`,
    `  Issue: ${result.issue?.url ?? "n/a"} (${result.issue?.state ?? "unknown"})`,
    `  Labels: ${result.issue?.labels?.join(", ") ?? "n/a"}`,
    `  Dispatch cycle: ${result.lifecycle.dispatchCycleId ?? "n/a"}`,
    `  Dispatch run: ${result.lifecycle.dispatchRunId ?? "n/a"}`,
    `  Progress state: ${result.lifecycle.progressState}`,
    `  Agent accepted: ${result.lifecycle.agentAcceptedAt ?? "n/a"}`,
    `  First worker activity: ${result.lifecycle.firstWorkerActivityAt ?? "n/a"}`,
    `  Session completed: ${result.lifecycle.sessionCompletedAt ?? "n/a"}`,
    `  Convergence cause: ${result.convergence.cause ?? "none"}`,
    `  QA subcause: ${result.convergence.qaSubcause ?? "n/a"}`,
    `  Missing QA gates: ${result.convergence.qaMissingGates.length ? result.convergence.qaMissingGates.join(", ") : "n/a"}`,
    `  Convergence action: ${result.convergence.action ?? "none"}`,
    `  Retry count: ${result.convergence.retryCount}`,
    `  Convergence head SHA: ${result.convergence.headSha ?? "n/a"}`,
    `  Head SHA changed since last convergence: ${result.convergence.headShaChangedSinceLastConvergence == null ? "unknown" : (result.convergence.headShaChangedSinceLastConvergence ? "yes" : "no")}`,
    `  Last reason: ${result.convergence.reason ?? "n/a"}`,
    `  Suggested next action: ${result.recommendation.likelyNextAction}`,
  ];
  return lines.join("\n");
}
