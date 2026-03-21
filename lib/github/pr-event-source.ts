import type { FabricaRun, FabricaRunState, RepoIdentity } from "./types.js";
import type { FabricaRunStore } from "./event-store.js";
import { syncQualityGate, type QualityGateSyncResult } from "./quality-gate.js";

export type PrEventInput = {
  source: "webhook" | "polling";
  projectSlug: string;
  issueId: number;
  prNumber: number;
  headSha: string;
  prState: "open" | "closed" | "merged";
  /** Real GitHub deliveryId for webhooks; synthetic "poll-<ts>-<issueId>" for polling. */
  deliveryId: string;
  repoIdentity: RepoIdentity;
};

function buildRunId(installationId: number, repositoryId: number, prNumber: number, headSha: string): string {
  return `${installationId}:${repositoryId}:${prNumber}:${headSha}`;
}

function mapPrStateToRunState(prState: "open" | "closed" | "merged"): FabricaRunState {
  if (prState === "merged") return "passed";
  if (prState === "closed") return "aborted";
  return "planned";
}

/**
 * Find an existing FabricaRun for the PR or create a new one.
 * DEDUP RULE: Uses findByPr(installationId, repositoryId, prNumber) — never creates
 * a duplicate Run for the same PR regardless of headSha.
 * Returns { run, created } — created=false means an existing Run was found.
 */
export async function ensureFabricaRun(
  runStore: FabricaRunStore,
  input: PrEventInput,
): Promise<{ run: FabricaRun; created: boolean }> {
  // findByPr returns FabricaRun[] — at most one due to save() dedup logic
  const existing = (
    await runStore.findByPr(
      input.repoIdentity.installationId,
      input.repoIdentity.repositoryId,
      input.prNumber,
    )
  )[0] ?? null;

  if (existing) {
    return { run: existing, created: false };
  }

  const runId = buildRunId(
    input.repoIdentity.installationId,
    input.repoIdentity.repositoryId,
    input.prNumber,
    input.headSha,
  );
  const run: FabricaRun = {
    runId,
    installationId: input.repoIdentity.installationId,
    repositoryId: input.repoIdentity.repositoryId,
    prNumber: input.prNumber,
    headSha: input.headSha,
    issueRuntimeId: `${input.projectSlug}:${input.issueId}`,
    state: mapPrStateToRunState(input.prState),
    checkRunId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await runStore.save(run);
  return { run, created: true };
}

/**
 * Transition an existing FabricaRun based on current PR state from polling.
 * Handles PR_SYNCHRONIZED (headSha change) and PR_MERGED / PR_CLOSED_UNMERGED.
 * Returns the updated Run if a transition occurred, null if no change needed.
 */
export async function transitionFabricaRun(
  runStore: FabricaRunStore,
  run: FabricaRun,
  input: PrEventInput,
): Promise<FabricaRun | null> {
  let nextState = run.state;
  let nextHeadSha = run.headSha;
  let changed = false;

  // Check terminal state changes first (PR_MERGED, PR_CLOSED_UNMERGED)
  if (input.prState === "merged" && run.state !== "passed") {
    nextState = "passed";
    changed = true;
  } else if (input.prState === "closed" && run.state !== "aborted") {
    nextState = "aborted";
    changed = true;
  }

  // Check headSha change (PR_SYNCHRONIZED) — only for open PRs
  if (!changed && input.prState === "open" && input.headSha !== run.headSha) {
    nextHeadSha = input.headSha;
    changed = true;
  }

  if (!changed) return null;

  const nextRun: FabricaRun = {
    ...run,
    state: nextState,
    headSha: nextHeadSha,
    // Rebuild runId with new headSha (save() handles old run cleanup via repositoryId/prNumber dedup)
    runId: buildRunId(run.installationId, run.repositoryId, run.prNumber, nextHeadSha),
    updatedAt: new Date().toISOString(),
  };
  await runStore.save(nextRun);
  return nextRun;
}

/**
 * Sync the GitHub Check Run for a FabricaRun using polling-originated identity.
 */
export async function syncQualityGateFromInput(params: {
  pluginConfig?: Record<string, unknown>;
  input: PrEventInput;
  run: FabricaRun;
  runStore: FabricaRunStore;
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void };
}): Promise<QualityGateSyncResult> {
  return syncQualityGate({
    pluginConfig: params.pluginConfig,
    repoIdentity: {
      ...params.input.repoIdentity,
      merged: params.input.prState === "merged",
    },
    run: params.run,
    runStore: params.runStore,
    logger: params.logger,
    source: params.input.source,
    deliveryId: params.input.deliveryId,
  });
}
