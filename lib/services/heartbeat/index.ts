/**
 * Heartbeat tick — token-free queue processing.
 *
 * Runs automatically via plugin service (periodic execution).
 *
 * Logic:
 *   1. Health pass: auto-fix zombies, stale workers, orphaned state
 *   2. Tick pass: fill free worker slots by priority
 *
 * Zero LLM tokens — all logic is deterministic code + CLI calls.
 * Workers only consume tokens when they start processing dispatched tasks.
 */
import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk";
import type { PluginContext } from "../../context.js";
import { ensureDefaultFiles } from "../../setup/workspace.js";
import {
  fetchGatewaySessions,
} from "./health.js";
import type { Agent } from "./agent-discovery.js";
import { discoverAgents } from "./agent-discovery.js";
import { HEARTBEAT_DEFAULTS, resolveHeartbeatConfig } from "./config.js";
import type { HeartbeatConfig } from "./config.js";
import { processPendingGitHubEventsForWorkspace } from "../../github/process-events.js";
import { getLifecycleService } from "../../machines/lifecycle-service.js";

export { HEARTBEAT_DEFAULTS };
import { tick, type TickMode } from "./tick-runner.js";
import type { TickResult } from "./tick-runner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServiceContext = {
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  config: {
    agents?: { list?: Array<{ id: string; workspace?: string }> };
  };
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function registerHeartbeatService(api: OpenClawPluginApi, pluginCtx: PluginContext) {
  // Single shared interval — alternates repair/triage each tick so the two
  // modes never compete for the _anyTickRunning mutex.
  let sharedIntervalId: ReturnType<typeof setInterval> | null = null;
  let tickCount = 0;

  api.registerService({
    id: "fabrica-heartbeat",

    start: async (svcCtx: ServiceContext) => {
      const { intervalSeconds } = resolveHeartbeatConfig(pluginCtx.pluginConfig);
      const intervalMs = intervalSeconds * 1000;

      // Warm-up: run repair immediately on start.
      setTimeout(() => runHeartbeatTick(pluginCtx, svcCtx.logger, "repair"), 2_000);

      // Shared interval: even ticks → repair, odd ticks → triage.
      sharedIntervalId = setInterval(() => {
        const mode: TickMode = tickCount % 2 === 0 ? "repair" : "triage";
        tickCount++;
        runHeartbeatTick(pluginCtx, svcCtx.logger, mode);
      }, intervalMs);
    },

    stop: async (svcCtx) => {
      if (sharedIntervalId) {
        clearInterval(sharedIntervalId);
        sharedIntervalId = null;
        svcCtx.logger.info("work_heartbeat service stopped");
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Tick orchestration
// ---------------------------------------------------------------------------

/**
 * Run one heartbeat tick for all agents.
 * Re-reads config and re-discovers agents each tick so projects onboarded
 * after the gateway starts are picked up automatically — no restart needed.
 *
 * Guarded by _tickRunning to prevent concurrent ticks from interleaving
 * (setInterval + async means the next tick can fire while the previous awaits).
 */
const _tickRunning: Record<TickMode, boolean> = {
  full: false,
  repair: false,
  triage: false,
};
let _anyTickRunning = false;

async function runHeartbeatTick(
  ctx: PluginContext,
  logger: ServiceContext["logger"],
  mode: TickMode,
): Promise<void> {
  if (_anyTickRunning || _tickRunning[mode]) return;
  _anyTickRunning = true;
  _tickRunning[mode] = true;
  try {
    const workspace = discoverAgents(ctx.config)[0]?.workspace;
    const lifecycle = workspace ? await getLifecycleService(workspace, logger) : null;
    const run = () => ctx.observability.withContext({ phase: `heartbeat:${mode}` }, () =>
      ctx.observability.withSpan("fabrica.heartbeat.tick", { phase: `heartbeat:${mode}` }, async () => {
        const config = resolveHeartbeatConfig(ctx.pluginConfig);
        if (!config.enabled) return;

        const agents = discoverAgents(ctx.config);
        if (agents.length === 0) return;

        const result = await processAllAgents(agents, config, ctx.pluginConfig, logger, ctx.runCommand, ctx.runtime, mode);
        logTickResult(result, logger, mode);
      }),
    );
    if (lifecycle) {
      await lifecycle.track(mode === "repair" ? "recovery" : "heartbeat", {}, run);
    } else {
      await run();
    }
  } catch (err) {
    logger.error(`work_heartbeat ${mode} tick failed: ${err}`);
  } finally {
    _tickRunning[mode] = false;
    _anyTickRunning = false;
  }
}

/**
 * Process heartbeat tick for all agents and aggregate results.
 */
async function processAllAgents(
  agents: Agent[],
  config: HeartbeatConfig,
  pluginConfig: Record<string, unknown> | undefined,
  logger: ServiceContext["logger"],
  runCommand: import("../../context.js").RunCommand,
  runtime?: PluginRuntime,
  mode: TickMode = "full",
): Promise<TickResult> {
  const result: TickResult = {
    totalPickups: 0,
    totalHealthFixes: 0,
    totalSkipped: 0,
    totalReviewTransitions: 0,
    totalReviewSkipTransitions: 0,
    totalTestSkipTransitions: 0,
    totalHoldEscapes: 0,
  };

  if (mode !== "triage") {
    const refreshedWorkspaces = new Set<string>();
    for (const { workspace } of agents) {
      if (refreshedWorkspaces.has(workspace)) continue;
      refreshedWorkspaces.add(workspace);
      try {
        await ensureDefaultFiles(workspace);
        await processPendingGitHubEventsForWorkspace({
          workspaceDir: workspace,
          pluginConfig,
          logger,
        });
      } catch (err) {
        logger.warn(`Workspace refresh failed for ${workspace}: ${(err as Error).message}`);
      }
    }
  }

  // Fetch gateway sessions once for all agents/projects
  const sessions = await fetchGatewaySessions(undefined, runCommand);

  for (const { agentId, workspace } of agents) {
    const agentResult = await tick({
      workspaceDir: workspace,
      agentId,
      config,
      pluginConfig,
      sessions,
      logger,
      runtime,
      runCommand,
      mode,
    });

    result.totalPickups += agentResult.totalPickups;
    result.totalHealthFixes += agentResult.totalHealthFixes;
    result.totalSkipped += agentResult.totalSkipped;
    result.totalReviewTransitions += agentResult.totalReviewTransitions;
    result.totalReviewSkipTransitions += agentResult.totalReviewSkipTransitions;
    result.totalTestSkipTransitions += agentResult.totalTestSkipTransitions;
    result.totalHoldEscapes += agentResult.totalHoldEscapes;
  }

  return result;
}

/**
 * Log tick results if anything happened.
 */
function logTickResult(
  result: TickResult,
  logger: ServiceContext["logger"],
  mode: TickMode,
): void {
  if (
    result.totalPickups > 0 ||
    result.totalHealthFixes > 0 ||
    result.totalReviewTransitions > 0 ||
    result.totalReviewSkipTransitions > 0 ||
    result.totalTestSkipTransitions > 0
  ) {
    logger.info(
      `work_heartbeat ${mode}: ${result.totalPickups} pickups, ${result.totalHealthFixes} health fixes, ${result.totalReviewTransitions} review transitions, ${result.totalReviewSkipTransitions} review skips, ${result.totalTestSkipTransitions} test skips, ${result.totalSkipped} skipped`,
    );
  }
}
