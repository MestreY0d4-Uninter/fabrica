import { z } from "zod";
import type { FabricaRunStore } from "./event-store.js";
import type { FabricaRun, GitHubEventRecord, RepoIdentity } from "./types.js";
import { getGitHubInstallationOctokit } from "./app-auth.js";
import { withCorrelationContext } from "../observability/context.js";
import { withTelemetrySpan } from "../observability/telemetry.js";

const qualityGatePayloadSchema = z.object({
  installation: z.object({ id: z.number().int().positive() }).optional(),
  repository: z.object({
    name: z.string().min(1),
    owner: z.object({ login: z.string().min(1) }),
  }).optional(),
  pull_request: z.object({
    head: z.object({ sha: z.string().min(1) }),
    merged: z.boolean().optional(),
    merged_at: z.string().nullable().optional(),
    html_url: z.string().url().optional(),
  }).optional(),
});

export const FABRICA_QUALITY_GATE_NAME = "Fabrica / Quality Gate";

export type QualityGateSyncResult = {
  attempted: boolean;
  skippedReason?: string;
  checkRunId?: number | null;
};

function resolveRepoIdentity(record: GitHubEventRecord): RepoIdentity | null {
  const parsed = qualityGatePayloadSchema.safeParse(record.payload);
  if (!parsed.success) return null;
  const installationId = parsed.data.installation?.id ?? record.installationId ?? null;
  const owner = parsed.data.repository?.owner.login ?? null;
  const repo = parsed.data.repository?.name ?? null;
  const headSha = parsed.data.pull_request?.head.sha ?? record.headSha ?? null;

  if (!installationId || !owner || !repo || !headSha) return null;
  return {
    installationId,
    repositoryId: record.repositoryId ?? 0,
    owner,
    repo,
    headSha,
    prUrl: parsed.data.pull_request?.html_url ?? null,
    merged: parsed.data.pull_request?.merged === true || Boolean(parsed.data.pull_request?.merged_at),
  };
}

function renderOutput(run: FabricaRun, eventInfo?: { eventName?: string; action?: string | null }): {
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "action_required";
  output: { title: string; summary: string };
} {
  const summary = [
    `Run: ${run.runId}`,
    eventInfo?.eventName
      ? `Event: ${eventInfo.eventName}${eventInfo.action ? `.${eventInfo.action}` : ""}`
      : `Source: polling`,
    `PR: #${run.prNumber}`,
    `Head SHA: ${run.headSha}`,
    run.issueRuntimeId ? `Issue runtime: ${run.issueRuntimeId}` : null,
  ].filter(Boolean).join("\n");

  switch (run.state) {
    case "passed":
      return {
        status: "completed",
        conclusion: "success",
        output: {
          title: "Fabrica quality gate passed",
          summary,
        },
      };
    case "gate":
      return {
        status: "completed",
        conclusion: "success",
        output: {
          title: "Fabrica quality gate is satisfied",
          summary,
        },
      };
    case "repairing":
      return {
        status: "completed",
        conclusion: "action_required",
        output: {
          title: "Fabrica is repairing this PR",
          summary,
        },
      };
    case "failed":
      return {
        status: "completed",
        conclusion: "action_required",
        output: {
          title: "Fabrica requires follow-up",
          summary,
        },
      };
    case "aborted":
      return {
        status: "completed",
        conclusion: "neutral",
        output: {
          title: "Fabrica run aborted",
          summary,
        },
      };
    case "waiting_review":
      return {
        status: "in_progress",
        output: {
          title: "Fabrica is waiting for review",
          summary,
        },
      };
    case "tests_running":
      return {
        status: "in_progress",
        output: {
          title: "Fabrica is running tests",
          summary,
        },
      };
    case "planned":
      return {
        status: "queued",
        output: {
          title: "Fabrica queued this PR for processing",
          summary,
        },
      };
    default:
      return {
        status: "in_progress",
        output: {
          title: "Fabrica is processing this PR",
          summary,
        },
      };
  }
}

export async function syncQualityGate(params: {
  pluginConfig?: Record<string, unknown>;
  repoIdentity: RepoIdentity;
  run: FabricaRun;
  runStore: FabricaRunStore;
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void };
  source?: "webhook" | "polling";
  deliveryId?: string;
}): Promise<QualityGateSyncResult> {
  const { repoIdentity } = params;
  return withCorrelationContext(
    {
      runId: params.run.runId,
      issueId: params.run.issueRuntimeId ?? undefined,
      prNumber: params.run.prNumber,
      headSha: params.run.headSha,
      deliveryId: params.deliveryId,
      checkRunId: params.run.checkRunId ?? undefined,
      phase: "quality-gate",
    },
    () => withTelemetrySpan("fabrica.pipeline.merge", {
      runId: params.run.runId,
      issueId: params.run.issueRuntimeId ?? undefined,
      prNumber: params.run.prNumber,
      headSha: params.run.headSha,
      deliveryId: params.deliveryId,
      checkRunId: params.run.checkRunId ?? undefined,
      phase: "quality-gate",
    }, async () => {
      const octokit = await getGitHubInstallationOctokit(params.pluginConfig, repoIdentity.installationId);
      if (!octokit) {
        return { attempted: false, skippedReason: "github_app_unavailable" };
      }

      const rendered = renderOutput(params.run, {
        eventName: params.source === "polling" ? "poll" : params.source,
      });

      if (params.run.checkRunId) {
        const response = await octokit.request(
          "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
          {
            owner: repoIdentity.owner,
            repo: repoIdentity.repo,
            check_run_id: params.run.checkRunId,
            name: FABRICA_QUALITY_GATE_NAME,
            status: rendered.status,
            conclusion: rendered.conclusion,
            completed_at: rendered.status === "completed" ? new Date().toISOString() : undefined,
            output: rendered.output,
          },
        );
        const nextRun = { ...params.run, checkRunId: response.data.id, updatedAt: new Date().toISOString() };
        await params.runStore.save(nextRun);
        params.logger?.info?.({ runId: params.run.runId, checkRunId: response.data.id }, "Updated Fabrica quality gate");
        return { attempted: true, checkRunId: response.data.id };
      }

      const response = await octokit.request(
        "POST /repos/{owner}/{repo}/check-runs",
        {
          owner: repoIdentity.owner,
          repo: repoIdentity.repo,
          name: FABRICA_QUALITY_GATE_NAME,
          head_sha: repoIdentity.headSha,
          status: rendered.status,
          conclusion: rendered.conclusion,
          completed_at: rendered.status === "completed" ? new Date().toISOString() : undefined,
          output: rendered.output,
          details_url: repoIdentity.prUrl ?? undefined,
        },
      );
      const nextRun = { ...params.run, checkRunId: response.data.id, updatedAt: new Date().toISOString() };
      await params.runStore.save(nextRun);
      params.logger?.info?.({ runId: params.run.runId, checkRunId: response.data.id }, "Created Fabrica quality gate");
      return { attempted: true, checkRunId: response.data.id };
    }),
  );
}

export async function syncQualityGateForRun(params: {
  pluginConfig?: Record<string, unknown>;
  eventRecord: GitHubEventRecord;
  run: FabricaRun;
  runStore: FabricaRunStore;
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void };
}): Promise<QualityGateSyncResult> {
  const identity = resolveRepoIdentity(params.eventRecord);
  if (!identity) {
    return { attempted: false, skippedReason: "missing_repo_identity" };
  }
  return syncQualityGate({
    pluginConfig: params.pluginConfig,
    repoIdentity: identity,
    run: params.run,
    runStore: params.runStore,
    logger: params.logger,
    source: "webhook",
    deliveryId: params.eventRecord.deliveryId,
  });
}
