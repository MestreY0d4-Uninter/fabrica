import { log as auditLog } from "../audit.js";
import type { RunCommand } from "../context.js";
import { runIssueDoctor } from "../setup/doctor-run.js";

export async function captureIssueDoctorSnapshot(opts: {
  workspaceDir: string;
  projectSlug: string;
  issueId: number;
  runCommand: RunCommand;
  pluginConfig?: Record<string, unknown>;
  event: string;
  trigger: string;
  extra?: Record<string, unknown>;
}): Promise<void> {
  try {
    const result = await runIssueDoctor({
      workspacePath: opts.workspaceDir,
      projectSlug: opts.projectSlug,
      issueId: opts.issueId,
      runCommand: opts.runCommand,
      pluginConfig: opts.pluginConfig,
    });

    await auditLog(opts.workspaceDir, opts.event, {
      projectSlug: opts.projectSlug,
      issueId: opts.issueId,
      trigger: opts.trigger,
      summary: result.recommendation.summary,
      likelyNextAction: result.recommendation.likelyNextAction,
      doctor: {
        artifact: result.hasArtifact,
        progressState: result.lifecycle.progressState,
        dispatchCycleId: result.lifecycle.dispatchCycleId,
        dispatchRunId: result.lifecycle.dispatchRunId,
        prUrl: result.pr?.url ?? null,
        prState: result.pr?.state ?? null,
        labels: result.issue?.labels ?? [],
        convergenceCause: result.convergence.cause,
        convergenceAction: result.convergence.action,
        convergenceRetryCount: result.convergence.retryCount,
        convergenceHeadSha: result.convergence.headSha,
        headShaChangedSinceLastConvergence: result.convergence.headShaChangedSinceLastConvergence,
      },
      ...(opts.extra ?? {}),
    });
  } catch (error) {
    await auditLog(opts.workspaceDir, `${opts.event}_failed`, {
      projectSlug: opts.projectSlug,
      issueId: opts.issueId,
      trigger: opts.trigger,
      error: error instanceof Error ? error.message : String(error),
      ...(opts.extra ?? {}),
    }).catch(() => {});
  }
}
