import { z } from "zod";
import { readProjects } from "../projects/io.js";
import { updateIssueRuntime } from "../projects/mutations.js";
import type { Project, ProjectsData } from "../projects/types.js";
import {
  canBindIssueToPr,
  findCanonicalPrBinding,
  releaseCanonicalPrBinding,
  type CanonicalPrIdentity,
} from "../projects/pr-binding.js";
import type { FabricaRunStore, GitHubEventStore } from "./event-store.js";
import type { FabricaRun, GitHubEventRecord } from "./types.js";
import { createGitHubStores, type GitHubStoreBackend } from "./store-factory.js";
import { syncQualityGateForRun } from "./quality-gate.js";
import { withCorrelationContext } from "../observability/context.js";
import { withTelemetrySpan } from "../observability/telemetry.js";
import { transitionFabricaRun } from "../machines/fabrica-run-runner.js";

const pullRequestPayloadSchema = z.object({
  action: z.string().min(1),
  installation: z.object({ id: z.number().int().positive() }).optional(),
  repository: z.object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    owner: z.object({ login: z.string().min(1) }),
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string().default(""),
    body: z.string().nullable().optional(),
    html_url: z.string().url().optional(),
    state: z.string().optional(),
    head: z.object({
      sha: z.string().min(1),
      ref: z.string().min(1).optional(),
    }),
    merged: z.boolean().optional(),
    merged_at: z.string().nullable().optional(),
  }),
});

const pullRequestReviewPayloadSchema = z.object({
  action: z.string().min(1),
  installation: z.object({ id: z.number().int().positive() }).optional(),
  repository: z.object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    owner: z.object({ login: z.string().min(1) }),
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string().default(""),
    body: z.string().nullable().optional(),
    html_url: z.string().url().optional(),
    head: z.object({
      sha: z.string().min(1),
      ref: z.string().min(1).optional(),
    }),
  }),
  review: z.object({
    state: z.string().min(1),
  }),
});

type ProcessingLogger = {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

export type GitHubEventProcessingResult = {
  backend: GitHubStoreBackend;
  pending: number;
  processed: number;
  failed: number;
  skipped: number;
  deadLettered: number;
  qualityGateUpdates: number;
};

const GITHUB_EVENT_MAX_ATTEMPTS = 5;

function computeRetryDelayMs(attemptCount: number): number {
  const bounded = Math.max(1, Math.min(attemptCount, GITHUB_EVENT_MAX_ATTEMPTS));
  return Math.min(60_000, 1_000 * 2 ** (bounded - 1));
}

function extractExplicitIssueRefs(...texts: Array<string | null | undefined>): number[] {
  const refs = new Set<number>();
  const add = (raw: string) => {
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) refs.add(value);
  };

  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(/#(\d+)\b/g)) add(match[1]!);
    for (const match of text.matchAll(/\bissue\s+#?(\d+)\b/gi)) add(match[1]!);
  }

  return Array.from(refs).sort((a, b) => a - b);
}

function normalizeRepoRemote(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const normalized = value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^ssh:\/\/git@github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/^git:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  const parts = normalized.split("/");
  return parts.length === 2 && parts[0] && parts[1] ? normalized : null;
}

function findProjectForRepository(
  data: ProjectsData,
  owner: string,
  repo: string,
): { slug: string; project: Project } | null {
  const target = `${owner}/${repo}`.toLowerCase();
  for (const [slug, project] of Object.entries(data.projects)) {
    const remote = normalizeRepoRemote(project.repoRemote);
    if (remote && remote === target) return { slug, project };
  }
  return null;
}

function buildRunId(
  installationId: number,
  repositoryId: number,
  prNumber: number,
  headSha: string,
): string {
  return `${installationId}:${repositoryId}:${prNumber}:${headSha}`;
}

function isMergedPullRequestPayload(payload: unknown): boolean {
  const parsed = pullRequestPayloadSchema.safeParse(payload);
  if (!parsed.success) return false;
  return parsed.data.pull_request.merged === true || Boolean(parsed.data.pull_request.merged_at);
}

async function upsertIssueRuntimeBinding(params: {
  workspaceDir: string;
  record: GitHubEventRecord;
  runId?: string | null;
  checkRunId?: number | null;
  prNumber: number;
  prUrl: string | null;
  headSha: string;
  issueIds: number[];
  state: string;
  logger?: ProcessingLogger;
}): Promise<void> {
  if (params.issueIds.length !== 1) return;

  const parsed = pullRequestPayloadSchema.safeParse(params.record.payload);
  const reviewParsed = pullRequestReviewPayloadSchema.safeParse(params.record.payload);
  const payload = parsed.success ? parsed.data : reviewParsed.success ? reviewParsed.data : null;
  if (!payload?.repository) return;

  const projects = await readProjects(params.workspaceDir);
  const match = findProjectForRepository(
    projects,
    payload.repository.owner.login,
    payload.repository.name,
  );
  if (!match) return;

  await updateIssueRuntime(
    params.workspaceDir,
    match.slug,
    params.issueIds[0],
    {
      artifactOfRecord: params.state === "merged"
        ? {
            prNumber: params.prNumber,
            headSha: params.headSha,
            mergedAt: new Date().toISOString(),
            url: params.prUrl,
          }
        : null,
      currentPrNumber: params.prNumber,
      currentPrUrl: params.prUrl,
      currentPrState: params.state,
      currentPrInstallationId: payload.installation?.id ?? params.record.installationId ?? null,
      currentPrRepositoryId: payload.repository.id,
      currentPrHeadSha: params.headSha,
      currentPrSourceBranch: payload.pull_request.head.ref ?? null,
      currentPrIssueTarget: params.issueIds[0],
      lastHeadSha: params.headSha,
      lastRunId: params.runId ?? null,
      lastCheckRunId: params.checkRunId ?? null,
      lastGitHubDeliveryId: params.record.deliveryId,
      lastSessionKey: null,
      bindingSource: "explicit",
      bindingConfidence: "high",
      followUpPrRequired: params.state === "merged" ? false : undefined,
      boundAt: new Date().toISOString(),
    },
  );
}

async function processOneEvent(params: {
  workspaceDir: string;
  record: GitHubEventRecord;
  runStore: FabricaRunStore;
  pluginConfig?: Record<string, unknown>;
  logger?: ProcessingLogger;
}): Promise<{
  outcome: "processed" | "skipped";
  qualityGateUpdated: boolean;
  runId?: string | null;
  issueRuntimeId?: string | null;
  checkRunId?: number | null;
}> {
  const { record, runStore, pluginConfig, logger } = params;
  return withCorrelationContext(
    {
      deliveryId: record.deliveryId,
      prNumber: record.prNumber ?? undefined,
      headSha: record.headSha ?? undefined,
      phase: "github-process",
    },
    () => withTelemetrySpan("fabrica.events.process", {
      deliveryId: record.deliveryId,
      prNumber: record.prNumber ?? undefined,
      headSha: record.headSha ?? undefined,
      phase: "github-process",
      eventName: record.eventName,
      action: record.action ?? undefined,
    }, async () => {
      let nextRun: FabricaRun | null = null;
      let resolvedIssueId: number | null = null;
      let resolvedProjectSlug: string | null = null;

      if (record.eventName === "pull_request") {
    const payload = pullRequestPayloadSchema.parse(record.payload);
    const explicitIssueRefs = extractExplicitIssueRefs(payload.pull_request.title, payload.pull_request.body ?? "");
    const identity: CanonicalPrIdentity = {
      installationId: payload.installation?.id ?? record.installationId ?? 0,
      repositoryId: payload.repository.id,
      prNumber: payload.pull_request.number,
      headSha: payload.pull_request.head.sha,
    };
    const projects = await readProjects(params.workspaceDir);
    const match = findProjectForRepository(
      projects,
      payload.repository.owner.login,
      payload.repository.name,
    );
    const existingBinding = await findCanonicalPrBinding(params.workspaceDir, identity);
    if (existingBinding) {
      resolvedIssueId = existingBinding.issueId;
      resolvedProjectSlug = existingBinding.slug;
      if (
        explicitIssueRefs.length > 0 &&
        !explicitIssueRefs.includes(existingBinding.issueId) &&
        payload.action !== "closed"
      ) {
        await releaseCanonicalPrBinding({
          workspaceDir: params.workspaceDir,
          slug: existingBinding.slug,
          issueId: existingBinding.issueId,
          identity,
          deliveryId: record.deliveryId,
          reason: "retargeted",
          nextIssueTarget: explicitIssueRefs.length === 1 ? explicitIssueRefs[0]! : null,
        });
        resolvedIssueId = null;
        resolvedProjectSlug = null;
      }
    }
    if (
      resolvedIssueId == null &&
      explicitIssueRefs.length === 1 &&
      match &&
      canBindIssueToPr(match.project, explicitIssueRefs[0]!, identity)
    ) {
      resolvedIssueId = explicitIssueRefs[0]!;
      resolvedProjectSlug = match.slug;
    }
    const runId = buildRunId(
      identity.installationId,
      identity.repositoryId,
      identity.prNumber,
      identity.headSha ?? "",
    );
    const existing = await runStore.get(runId);
    const existingCheckRunId = existing?.checkRunId ?? null;
    const existingCreatedAt = existing?.createdAt ?? new Date().toISOString();
    const nextRunBase = existing ?? {
      runId,
      installationId: identity.installationId,
      repositoryId: payload.repository.id,
      prNumber: payload.pull_request.number,
      headSha: payload.pull_request.head.sha,
      issueRuntimeId: resolvedIssueId != null ? String(resolvedIssueId) : null,
      state: "planned" as const,
      checkRunId: existingCheckRunId,
      createdAt: existingCreatedAt,
      updatedAt: new Date().toISOString(),
    };
    const nextEvent =
      payload.action === "closed"
        ? (payload.pull_request.merged === true || Boolean(payload.pull_request.merged_at)
          ? {
              type: "PR_MERGED" as const,
              artifactOfRecord: {
                prNumber: payload.pull_request.number,
                headSha: payload.pull_request.head.sha,
                mergedAt: payload.pull_request.merged_at ?? new Date().toISOString(),
                url: payload.pull_request.html_url ?? null,
              },
            }
          : { type: "PR_CLOSED_UNMERGED" as const })
        : payload.action === "reopened"
          ? { type: "PR_REOPENED" as const, headSha: payload.pull_request.head.sha }
          : payload.action === "synchronize"
            ? {
                type: existing?.headSha && existing.headSha !== payload.pull_request.head.sha
                  ? "FORCE_PUSH" as const
                  : "PR_SYNCHRONIZED" as const,
                headSha: payload.pull_request.head.sha,
              }
            : { type: "PR_OPENED" as const, headSha: payload.pull_request.head.sha };
    const transitioned = transitionFabricaRun({
      run: nextRunBase,
      event: nextEvent,
      runtime: resolvedIssueId != null && resolvedProjectSlug
        ? projects.projects[resolvedProjectSlug]?.issueRuntime?.[String(resolvedIssueId)] ?? null
        : existingBinding?.runtime ?? null,
      issueRuntimeId: resolvedIssueId != null ? String(resolvedIssueId) : nextRunBase.issueRuntimeId,
    });
    nextRun = transitioned.run;

    await runStore.save(nextRun);
    if (resolvedIssueId != null && resolvedProjectSlug) {
      await upsertIssueRuntimeBinding({
        workspaceDir: params.workspaceDir,
        record,
        runId,
        checkRunId: existing?.checkRunId ?? null,
        prNumber: payload.pull_request.number,
        prUrl: payload.pull_request.html_url ?? null,
        headSha: payload.pull_request.head.sha,
        issueIds: [resolvedIssueId],
        state: payload.pull_request.merged === true ? "merged" : payload.pull_request.state ?? "open",
        logger,
      });
    }
      } else if (record.eventName === "pull_request_review") {
    const payload = pullRequestReviewPayloadSchema.parse(record.payload);
    if (payload.action !== "submitted") {
      return {
        outcome: "skipped",
        qualityGateUpdated: false,
        runId: null,
        issueRuntimeId: null,
        checkRunId: null,
      };
    }
    const explicitIssueRefs = extractExplicitIssueRefs(payload.pull_request.title, payload.pull_request.body ?? "");
    const identity: CanonicalPrIdentity = {
      installationId: payload.installation?.id ?? record.installationId ?? 0,
      repositoryId: payload.repository.id,
      prNumber: payload.pull_request.number,
      headSha: payload.pull_request.head.sha,
    };
    const projects = await readProjects(params.workspaceDir);
    const match = findProjectForRepository(
      projects,
      payload.repository.owner.login,
      payload.repository.name,
    );
    const existingBinding = await findCanonicalPrBinding(params.workspaceDir, identity);
    if (existingBinding) {
      resolvedIssueId = existingBinding.issueId;
      resolvedProjectSlug = existingBinding.slug;
    } else if (
      explicitIssueRefs.length === 1 &&
      match &&
      canBindIssueToPr(match.project, explicitIssueRefs[0]!, identity)
    ) {
      resolvedIssueId = explicitIssueRefs[0]!;
      resolvedProjectSlug = match.slug;
    }
    const runId = buildRunId(
      identity.installationId,
      identity.repositoryId,
      identity.prNumber,
      identity.headSha ?? "",
    );
    const existing = await runStore.get(runId);
    const existingIssueRuntimeId = existing?.issueRuntimeId ?? null;
    const existingCheckRunId = existing?.checkRunId ?? null;
    const existingCreatedAt = existing?.createdAt ?? new Date().toISOString();
    const reviewState = payload.review.state.toUpperCase();
    const nextRunBase = existing ?? {
      runId,
      installationId: identity.installationId,
      repositoryId: payload.repository.id,
      prNumber: payload.pull_request.number,
      headSha: payload.pull_request.head.sha,
      issueRuntimeId: resolvedIssueId != null
        ? String(resolvedIssueId)
        : existingIssueRuntimeId,
      state: "waiting_review" as const,
      checkRunId: existingCheckRunId,
      createdAt: existingCreatedAt,
      updatedAt: new Date().toISOString(),
    };
    const transitioned = transitionFabricaRun({
      run: nextRunBase,
      event: reviewState === "CHANGES_REQUESTED"
        ? { type: "CHANGES_REQUESTED" }
        : reviewState === "APPROVED"
          ? { type: "REVIEW_APPROVED" }
          : { type: "PR_OPENED", headSha: payload.pull_request.head.sha },
      runtime: resolvedIssueId != null && resolvedProjectSlug
        ? projects.projects[resolvedProjectSlug]?.issueRuntime?.[String(resolvedIssueId)] ?? null
        : existingBinding?.runtime ?? null,
      issueRuntimeId: resolvedIssueId != null
        ? String(resolvedIssueId)
        : nextRunBase.issueRuntimeId,
    });
    nextRun = transitioned.run;
    await runStore.save(nextRun);
    if (resolvedIssueId != null && resolvedProjectSlug) {
      await upsertIssueRuntimeBinding({
        workspaceDir: params.workspaceDir,
        record,
        runId,
        checkRunId: existing?.checkRunId ?? null,
        prNumber: payload.pull_request.number,
        prUrl: payload.pull_request.html_url ?? null,
        headSha: payload.pull_request.head.sha,
        issueIds: [resolvedIssueId],
        state: "open",
        logger,
      });
    }
      } else {
        return {
          outcome: "skipped",
          qualityGateUpdated: false,
          runId: null,
          issueRuntimeId: null,
          checkRunId: null,
        };
      }

      let qualityGateUpdated = false;
      let latestCheckRunId = nextRun?.checkRunId ?? null;
      if (nextRun) {
        const gate = await syncQualityGateForRun({
          pluginConfig,
          eventRecord: record,
          run: nextRun,
          runStore,
          logger,
        });
        if (gate.attempted) {
          qualityGateUpdated = true;
          latestCheckRunId = gate.checkRunId ?? latestCheckRunId;
          const explicitIssueRefs = nextRun.issueRuntimeId ? [Number(nextRun.issueRuntimeId)] : [];
          if (explicitIssueRefs.length === 1) {
            await upsertIssueRuntimeBinding({
              workspaceDir: params.workspaceDir,
              record,
              runId: nextRun.runId,
              checkRunId: gate.checkRunId ?? null,
              prNumber: nextRun.prNumber,
              prUrl: null,
              headSha: nextRun.headSha,
              issueIds: explicitIssueRefs,
              state: nextRun.state === "passed" && isMergedPullRequestPayload(record.payload) ? "merged" : "open",
              logger,
            });
          }
          logger?.info?.(
            {
              deliveryId: record.deliveryId,
              runId: nextRun.runId,
              prNumber: nextRun.prNumber,
              checkRunId: gate.checkRunId ?? null,
            },
            "Synced Fabrica quality gate",
          );
        } else if (gate.skippedReason) {
          logger?.warn?.(
            { deliveryId: record.deliveryId, runId: nextRun.runId, reason: gate.skippedReason },
            "Skipped Fabrica quality gate sync",
          );
        }
      }

      return {
        outcome: "processed",
        qualityGateUpdated,
        runId: nextRun?.runId ?? null,
        issueRuntimeId: nextRun?.issueRuntimeId ?? null,
        checkRunId: latestCheckRunId,
      };
    }),
  );
}

export async function processPendingGitHubEvents(params: {
  workspaceDir: string;
  eventStore: GitHubEventStore;
  runStore: FabricaRunStore;
  pluginConfig?: Record<string, unknown>;
  logger?: ProcessingLogger;
  backend?: GitHubStoreBackend;
}): Promise<GitHubEventProcessingResult> {
  const result: GitHubEventProcessingResult = {
    backend: params.backend ?? "file",
    pending: 0,
    processed: 0,
    failed: 0,
    skipped: 0,
    deadLettered: 0,
    qualityGateUpdates: 0,
  };

  while (true) {
    const claimed = await params.eventStore.claimReady(25);
    if (claimed.length === 0) break;
    result.pending += claimed.length;
    for (const record of claimed) {
      try {
        const { outcome, qualityGateUpdated, runId, issueRuntimeId, checkRunId } = await processOneEvent({
          workspaceDir: params.workspaceDir,
          record,
          runStore: params.runStore,
          pluginConfig: params.pluginConfig,
          logger: params.logger,
        });
        await params.eventStore.update(record.deliveryId, {
          status: outcome === "processed" ? "success" : "skipped",
          error: null,
          processedAt: new Date().toISOString(),
          nextAttemptAt: null,
          lastErrorAt: null,
          deadLetter: false,
          runId: runId ?? null,
          issueRuntimeId: issueRuntimeId ?? null,
          checkRunId: checkRunId ?? null,
        });
        if (outcome === "processed") result.processed += 1;
        else result.skipped += 1;
        if (qualityGateUpdated) result.qualityGateUpdates += 1;
      } catch (error) {
        const errorAt = new Date().toISOString();
        const shouldDeadLetter = record.attemptCount >= GITHUB_EVENT_MAX_ATTEMPTS;
        const nextAttemptAt = shouldDeadLetter
          ? null
          : new Date(Date.now() + computeRetryDelayMs(record.attemptCount)).toISOString();
        result.failed += 1;
        if (shouldDeadLetter) result.deadLettered += 1;
        await params.eventStore.update(record.deliveryId, {
          status: "failed",
          error: (error as Error).message,
          processedAt: errorAt,
          nextAttemptAt,
          lastErrorAt: errorAt,
          deadLetter: shouldDeadLetter,
        });
        params.logger?.warn?.(
          {
            deliveryId: record.deliveryId,
            attemptCount: record.attemptCount,
            deadLettered: shouldDeadLetter,
            err: error,
          },
          "Failed to process GitHub webhook delivery",
        );
      }
    }
  }
  return result;
}

export async function processGitHubEventRecord(params: {
  workspaceDir: string;
  record: GitHubEventRecord;
  eventStore: GitHubEventStore;
  runStore: FabricaRunStore;
  pluginConfig?: Record<string, unknown>;
  logger?: ProcessingLogger;
}): Promise<{ outcome: "processed" | "skipped"; qualityGateUpdated: boolean }> {
  const result = await processOneEvent({
    workspaceDir: params.workspaceDir,
    record: params.record,
    runStore: params.runStore,
    pluginConfig: params.pluginConfig,
    logger: params.logger,
  });

  await params.eventStore.update(params.record.deliveryId, {
    status: result.outcome === "processed" ? "success" : "skipped",
    error: null,
    processedAt: new Date().toISOString(),
    nextAttemptAt: null,
    lastErrorAt: null,
    deadLetter: false,
    runId: result.runId ?? null,
    issueRuntimeId: result.issueRuntimeId ?? null,
    checkRunId: result.checkRunId ?? null,
  });
  return result;
}

export async function replayGitHubDeliveryForWorkspace(params: {
  workspaceDir: string;
  deliveryId: string;
  pluginConfig?: Record<string, unknown>;
  logger?: ProcessingLogger;
  backend?: GitHubStoreBackend;
}): Promise<GitHubEventProcessingResult & { deliveryId: string; found: boolean }> {
  const stores = await createGitHubStores(params.workspaceDir, {
    backend: params.backend,
    logger: params.logger,
  });
  const record = await stores.eventStore.get(params.deliveryId);
  const base: GitHubEventProcessingResult & { deliveryId: string; found: boolean } = {
    backend: stores.backend,
    deliveryId: params.deliveryId,
    found: Boolean(record),
    pending: record ? 1 : 0,
    processed: 0,
    failed: 0,
    skipped: 0,
    deadLettered: 0,
    qualityGateUpdates: 0,
  };
  if (!record) return base;

  try {
    const result = await processGitHubEventRecord({
      workspaceDir: params.workspaceDir,
      record,
      eventStore: stores.eventStore,
      runStore: stores.runStore,
      pluginConfig: params.pluginConfig,
      logger: params.logger,
    });
    if (result.outcome === "processed") base.processed = 1;
    else base.skipped = 1;
    if (result.qualityGateUpdated) base.qualityGateUpdates = 1;
  } catch (error) {
    base.failed = 1;
    await stores.eventStore.update(params.deliveryId, {
      status: "failed",
      error: (error as Error).message,
      processedAt: new Date().toISOString(),
      lastErrorAt: new Date().toISOString(),
    });
    params.logger?.warn?.(
      { deliveryId: params.deliveryId, err: error },
      "Failed to replay GitHub webhook delivery",
    );
  }
  return base;
}

export async function reconcileGitHubPullRequestForWorkspace(params: {
  workspaceDir: string;
  prNumber: number;
  pluginConfig?: Record<string, unknown>;
  logger?: ProcessingLogger;
  backend?: GitHubStoreBackend;
}): Promise<GitHubEventProcessingResult & { prNumber: number }> {
  const stores = await createGitHubStores(params.workspaceDir, {
    backend: params.backend,
    logger: params.logger,
  });
  const records = (await stores.eventStore.listEvents({ prNumber: params.prNumber }))
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const result: GitHubEventProcessingResult & { prNumber: number } = {
    backend: stores.backend,
    prNumber: params.prNumber,
    pending: records.length,
    processed: 0,
    failed: 0,
    skipped: 0,
    deadLettered: 0,
    qualityGateUpdates: 0,
  };

  for (const record of records) {
    try {
      const processed = await processGitHubEventRecord({
        workspaceDir: params.workspaceDir,
        record,
        eventStore: stores.eventStore,
        runStore: stores.runStore,
        pluginConfig: params.pluginConfig,
        logger: params.logger,
      });
      if (processed.outcome === "processed") result.processed += 1;
      else result.skipped += 1;
      if (processed.qualityGateUpdated) result.qualityGateUpdates += 1;
    } catch (error) {
      result.failed += 1;
      await stores.eventStore.update(record.deliveryId, {
        status: "failed",
        error: (error as Error).message,
        processedAt: new Date().toISOString(),
        lastErrorAt: new Date().toISOString(),
      });
      params.logger?.warn?.(
        { prNumber: params.prNumber, deliveryId: record.deliveryId, err: error },
        "Failed to reconcile GitHub PR delivery",
      );
    }
  }

  return result;
}

export async function processPendingGitHubEventsForWorkspace(params: {
  workspaceDir: string;
  pluginConfig?: Record<string, unknown>;
  logger?: ProcessingLogger;
  backend?: GitHubStoreBackend;
}): Promise<GitHubEventProcessingResult> {
  const stores = await createGitHubStores(params.workspaceDir, {
    backend: params.backend,
    logger: params.logger,
  });
  return processPendingGitHubEvents({
    workspaceDir: params.workspaceDir,
    eventStore: stores.eventStore,
    runStore: stores.runStore,
    pluginConfig: params.pluginConfig,
    logger: params.logger,
    backend: stores.backend,
  });
}
