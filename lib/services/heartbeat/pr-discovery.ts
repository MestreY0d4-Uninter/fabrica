import { ensureFabricaRun, transitionFabricaRun, syncQualityGateFromInput } from "../../github/pr-event-source.js";
import { log as auditLog } from "../../audit.js";
import type { IssueProvider } from "../../providers/provider.js";
import type { Project } from "../../projects/types.js";
import type { FabricaRunStore } from "../../github/event-store.js";
import { getCanonicalPrSelector } from "../../projects/index.js";

type DiscoveryLogger = {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
};

export type PrDiscoveryResult = {
  created: number;
  updated: number;
  skipped: number;
};

/**
 * PR Discovery pass — for each active worker slot, poll the provider for a PR
 * and create/update the FabricaRun record.
 *
 * Dedup: uses findByPr(installationId, repositoryId, prNumber) — never creates
 * a duplicate Run. The webhook drain (global, runs first) takes priority;
 * this pass is a no-op if the webhook already created the Run this tick.
 *
 * Runs on repair ticks only (called from within the `mode !== "triage"` block
 * in tick-runner.ts).
 */
export async function runPrDiscoveryPass(params: {
  workspaceDir: string;
  projectSlug: string;
  project: Project;
  provider: IssueProvider;
  runStore?: FabricaRunStore;  // allow injection for testing
  pluginConfig?: Record<string, unknown>;
  logger: DiscoveryLogger;
}): Promise<PrDiscoveryResult> {
  const result: PrDiscoveryResult = { created: 0, updated: 0, skipped: 0 };

  // Gather all active worker slots across roles and levels
  const activeSlots: Array<{ role: string; level: string; issueId: number }> = [];
  for (const [role, roleWorker] of Object.entries(params.project.workers ?? {})) {
    for (const [level, slots] of Object.entries(roleWorker.levels ?? {})) {
      for (const slot of slots ?? []) {
        if (!slot.active || !slot.issueId) continue;
        const issueId = parseInt(slot.issueId, 10);
        if (!Number.isInteger(issueId) || issueId <= 0) continue;
        activeSlots.push({ role, level, issueId });
      }
    }
  }

  if (activeSlots.length === 0) return result;

  // Use injected runStore (for tests) or create one lazily
  let runStore = params.runStore;
  if (!runStore) {
    // Import lazily to avoid circular deps and to keep test injection clean
    const { createGitHubStores } = await import("../../github/store-factory.js");
    const stores = await createGitHubStores(params.workspaceDir, { logger: params.logger as any });
    runStore = stores.runStore;
  }

  for (const { issueId } of activeSlots) {
    try {
      // Step 1: lightweight PR lookup (no review-state determination)
      const prSelector = getCanonicalPrSelector(params.project, issueId);
      const prDetails = await params.provider.getPrDetails(issueId, prSelector);
      if (!prDetails) {
        result.skipped++;
        continue;
      }

      // Step 2: build repoIdentity. GitHub App removed (distribution concern) —
      // use repositoryId as a stable sentinel for installationId so dedup logic
      // (findByPr / buildRunId) works consistently across polling ticks.
      const repoIdentity = {
        installationId: prDetails.repositoryId,
        repositoryId: prDetails.repositoryId,
        owner: prDetails.owner,
        repo: prDetails.repo,
        headSha: prDetails.headSha,
        prUrl: prDetails.prUrl,
        merged: prDetails.prState === "merged",
      };
      const pollingInput = {
        source: "polling" as const,
        projectSlug: params.projectSlug,
        issueId,
        prNumber: prDetails.prNumber,
        headSha: prDetails.headSha,
        prState: prDetails.prState,
        deliveryId: `poll-${Date.now()}-${issueId}`,
        repoIdentity,
      };

      const { run, created } = await ensureFabricaRun(runStore, pollingInput);

      if (created) {
        result.created++;
        await auditLog(params.workspaceDir, "pr_discovered_via_polling", {
          projectSlug: params.projectSlug,
          issueId,
          prNumber: prDetails.prNumber,
          headSha: prDetails.headSha,
          prState: prDetails.prState,
        }).catch(() => {});

        // Sync quality gate for newly discovered Runs
        await syncQualityGateFromInput({
          pluginConfig: params.pluginConfig,
          input: pollingInput,
          run,
          runStore,
          logger: params.logger as any,
        }).catch((err) => {
          params.logger.warn(`PR discovery: quality gate sync failed for issue #${issueId}: ${(err as Error).message}`);
        });
      } else {
        // Existing Run — check if headSha or prState changed
        const updated = await transitionFabricaRun(runStore, run, pollingInput);
        if (updated) {
          result.updated++;
          const auditEvent = prDetails.prState !== "open"
            ? "pr_state_change_via_polling"
            : "pr_updated_via_polling";
          await auditLog(params.workspaceDir, auditEvent, {
            projectSlug: params.projectSlug,
            issueId,
            prNumber: prDetails.prNumber,
            headSha: prDetails.headSha,
            prState: prDetails.prState,
          }).catch(() => {});

          // Sync quality gate for state change
          await syncQualityGateFromInput({
            pluginConfig: params.pluginConfig,
            input: pollingInput,
            run: updated,
            runStore,
            logger: params.logger as any,
          }).catch((err) => {
            params.logger.warn(`PR discovery: quality gate sync failed for issue #${issueId}: ${(err as Error).message}`);
          });
        }
      }
    } catch (err) {
      result.skipped++;
      params.logger.warn(`PR discovery: error processing issue #${issueId}: ${(err as Error).message}`);
      await auditLog(params.workspaceDir, "pr_discovery_error", {
        projectSlug: params.projectSlug,
        issueId,
        error: (err as Error).message,
      }).catch(() => {});
    }
  }

  return result;
}
