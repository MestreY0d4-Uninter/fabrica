import { z } from "zod";
import type { FabricaRunStore } from "./event-store.js";
import type { FabricaRun, GitHubEventRecord, RepoIdentity } from "./types.js";
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

  const repositoryId = record.repositoryId ?? null;
  if (!installationId || !owner || !repo || !headSha || !repositoryId) return null;
  return {
    installationId,
    repositoryId,
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

async function createOrUpdateCheckRunViaGhCli(
  owner: string,
  repo: string,
  opts: {
    name: string;
    headSha: string;
    status: string;
    conclusion?: string;
    completedAt?: string;
    output?: { title: string; summary: string };
    detailsUrl?: string;
    checkRunId?: number | null;
  },
): Promise<number | null> {
  try {
    const body: Record<string, unknown> = {
      name: opts.name,
      head_sha: opts.headSha,
      status: opts.status,
    };
    if (opts.conclusion) body.conclusion = opts.conclusion;
    if (opts.completedAt) body.completed_at = opts.completedAt;
    if (opts.output) body.output = opts.output;
    if (opts.detailsUrl) body.details_url = opts.detailsUrl;

    const { execa } = await import("execa");

    let stdout: string;
    if (opts.checkRunId) {
      // Update existing check run
      const result = await execa(
        "gh",
        ["api", `repos/${owner}/${repo}/check-runs/${opts.checkRunId}`, "--method", "PATCH", "--input", "-"],
        { input: JSON.stringify(body) },
      );
      stdout = result.stdout;
    } else {
      // Create new check run
      const result = await execa(
        "gh",
        ["api", `repos/${owner}/${repo}/check-runs`, "--method", "POST", "--input", "-"],
        { input: JSON.stringify(body) },
      );
      stdout = result.stdout;
    }

    const parsed = JSON.parse(stdout) as { id?: number };
    return parsed.id ?? null;
  } catch {
    return null;
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
      const rendered = renderOutput(params.run, params.source === "polling" ? { eventName: "polling" } : undefined);

      const checkRunId = await createOrUpdateCheckRunViaGhCli(
        repoIdentity.owner,
        repoIdentity.repo,
        {
          name: FABRICA_QUALITY_GATE_NAME,
          headSha: repoIdentity.headSha,
          status: rendered.status,
          conclusion: rendered.conclusion,
          completedAt: rendered.status === "completed" ? new Date().toISOString() : undefined,
          output: rendered.output,
          detailsUrl: repoIdentity.prUrl ?? undefined,
          checkRunId: params.run.checkRunId,
        },
      );

      if (checkRunId === null) {
        return { attempted: false, skippedReason: "gh_cli_check_run_failed" };
      }

      const nextRun = { ...params.run, checkRunId, updatedAt: new Date().toISOString() };
      await params.runStore.save(nextRun);
      const action = params.run.checkRunId ? "Updated" : "Created";
      params.logger?.info?.({ runId: params.run.runId, checkRunId }, `${action} Fabrica quality gate`);
      return { attempted: true, checkRunId };
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
