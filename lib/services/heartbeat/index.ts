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
import { raceWithTimeout } from "../../utils/async.js";
export { raceWithTimeout } from "../../utils/async.js";

export { HEARTBEAT_DEFAULTS };
import { tick, type TickMode } from "./tick-runner.js";
import type { TickResult } from "./tick-runner.js";
import { setPluginWakeHandler } from "./wake-bridge.js";
export { wakeHeartbeat } from "./wake-bridge.js";

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
  let sharedIntervalId: ReturnType<typeof setInterval> | null = null;
  let _pendingWake = false;

  api.registerService({
    id: "fabrica-heartbeat",

    start: async (svcCtx: ServiceContext) => {
      const { intervalSeconds } = resolveHeartbeatConfig(pluginCtx.pluginConfig);
      const intervalMs = intervalSeconds * 1000;

      // Warm-up: run full tick immediately on start.
      setTimeout(() => runHeartbeatTick(pluginCtx, svcCtx.logger, "full"), 2_000);

      // Every tick runs "full" mode (health + pickup).
      // Previous alternation (repair/triage) caused triage starvation:
      // repair ticks took >60s with many projects, blocking triage (the only
      // mode that does pickup) via the _anyTickRunning mutex.
      sharedIntervalId = setInterval(() => {
        runHeartbeatTick(pluginCtx, svcCtx.logger, "full").finally(() => {
          // If a wake trigger arrived while this tick was running, run another tick now.
          if (_pendingWake) {
            _pendingWake = false;
            svcCtx.logger.info("heartbeat_wake: running deferred full tick");
            runHeartbeatTick(pluginCtx, svcCtx.logger, "full");
          }
        });
      }, intervalMs);

      // Register wake bridge so reactive-dispatch hooks trigger immediate ticks.
      // If a tick is already in progress, queue a deferred tick (runs when current finishes).
      setPluginWakeHandler(async (reason) => {
        if (_anyTickRunning) {
          _pendingWake = true;
          svcCtx.logger.info(`heartbeat_wake: deferred (tick-in-progress), reason=${reason}`);
          return;
        }
        svcCtx.logger.info(`heartbeat_wake: running full tick, reason=${reason}`);
        await runHeartbeatTick(pluginCtx, svcCtx.logger, "full");
      });
    },

    stop: async (svcCtx) => {
      setPluginWakeHandler(null);
      if (sharedIntervalId) {
        clearInterval(sharedIntervalId);
        sharedIntervalId = null;
        svcCtx.logger.info("work_heartbeat service stopped");
      }
    },
  });
}

const DEFAULT_TICK_TIMEOUT_MS = 50_000;
let _ticksTimedOut = 0;

/** Expose timeout counter for audit logging (used by tick-runner). */
export function getTickTimeoutCount(): number { return _ticksTimedOut; }

/**
 * Acquire the global tick mutex, run fn(), then release it.
 * Returns "busy" immediately if the mutex is already held.
 * Used by CLI sweeps so they never run concurrently with the background heartbeat.
 */
export async function withTickMutex<T>(fn: () => Promise<T>): Promise<T | "busy"> {
  if (_anyTickRunning) return "busy";
  _anyTickRunning = true;
  try {
    return await fn();
  } finally {
    _anyTickRunning = false;
  }
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
  let timedOut = false;
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
    // Wrap with timeout to prevent stuck ticks from blocking forever.
    // P0-3: When the timeout fires we must NOT release the mutex — the original
    // tick promise is still running. We keep _anyTickRunning = true and attach
    // a .finally() to the live promise so the mutex is released only when the
    // promise actually settles.
    const tickFn = lifecycle
      ? () => lifecycle.track(mode === "repair" ? "recovery" : "heartbeat", {}, run)
      : run;

    // Deferred promise pattern — tickPromise is ALWAYS defined before raceWithTimeout.
    // This eliminates the race window where timeout fires before wrappedTickFn executes.
    let resolveTick!: (v: unknown) => void;
    let rejectTick!: (e: unknown) => void;
    const tickPromise = new Promise<unknown>((res, rej) => {
      resolveTick = res;
      rejectTick = rej;
    });
    // Prevent unhandled rejection if wrappedTickFn rejects before .finally() is attached
    tickPromise.catch(() => {});

    const wrappedTickFn = async () => {
      try {
        const result = await tickFn();
        resolveTick(result);
        return result;
      } catch (err) {
        rejectTick(err);
        throw err;
      }
    };

    const HARD_TICK_TIMEOUT_MS = 5 * 60_000;

    const raceResult = await raceWithTimeout(wrappedTickFn, DEFAULT_TICK_TIMEOUT_MS, () => {
      _ticksTimedOut++;
      timedOut = true;
      logger.warn(`work_heartbeat ${mode} tick timed out after ${DEFAULT_TICK_TIMEOUT_MS}ms (total timeouts: ${_ticksTimedOut})`);
      // Do NOT release mutex here — the tick promise is still running.
      // Release it when the promise settles (see .finally() below).
      // tickPromise is always defined (deferred pattern) — no guard needed.
      const hardTimeout = setTimeout(() => {
        logger.error("tick_mutex: hard timeout — forcing mutex release");
        _tickRunning[mode] = false;
        _anyTickRunning = false;
      }, HARD_TICK_TIMEOUT_MS);

      tickPromise.finally(() => {
        clearTimeout(hardTimeout);
        _tickRunning[mode] = false;
        _anyTickRunning = false;
      });
    });
    void raceResult;
  } catch (err) {
    logger.error(`work_heartbeat ${mode} tick failed: ${err}`);
  } finally {
    // Only release the mutex here for the non-timeout path.
    // The timeout path attaches a .finally() to tickPromise instead.
    if (!timedOut) {
      _tickRunning[mode] = false;
      _anyTickRunning = false;
    }
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
