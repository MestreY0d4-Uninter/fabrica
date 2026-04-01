/**
 * reactive-dispatch-hook.ts — Immediate heartbeat wake on worker lifecycle events.
 *
 * Four hooks:
 *   1. before_tool_call — inject trusted dispatch identity into delayed worker tools.
 *   2. after_tool_call — when work_finish is called, wake the heartbeat
 *      immediately so the next worker is dispatched in <5s instead of 60–120s.
 *   3. agent_end — when any Fabrica worker run ends (with or without work_finish),
 *      apply lifecycle-driven completion and wake the heartbeat for immediate triage.
 *   4. subagent_spawned — record spawn timestamp per session key so
 *      subagent-lifecycle-hook can compute accurate durationMs.
 *
 * All hooks are fire-and-forget. Never throw, never block gateway operation.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginContext } from "../context.js";
import { parseFabricaSessionKey } from "./bootstrap-hook.js";
import { wakeHeartbeat } from "../services/heartbeat/wake-bridge.js";
import { resolveWorkspaceDir } from "./attachment-hook.js";
import { bindDispatchRunIdBySessionKey } from "../projects/index.js";
import { handleWorkerAgentEnd } from "../services/worker-completion.js";

/** Tools whose completion should immediately trigger heartbeat triage. */
const COMPLETION_TOOLS = new Set(["work_finish"]);

/** Spawn timestamps keyed by childSessionKey. Used by subagent-lifecycle-hook for durationMs. */
const spawnTimes = new Map<string, number>();

/** Returns the recorded spawn timestamp for a session key, or undefined if not recorded. */
export function getSpawnTime(sessionKey: string): number | undefined {
  return spawnTimes.get(sessionKey);
}

/** Removes the spawn time entry for a session key. Call after consuming the value to prevent Map growth. */
export function clearSpawnTime(sessionKey: string): void {
  spawnTimes.delete(sessionKey);
}

export function registerReactiveDispatchHooks(
  api: OpenClawPluginApi,
  ctx: PluginContext,
): void {
  const workspaceDir = resolveWorkspaceDir(ctx.config as unknown as Record<string, unknown>);

  api.on("before_tool_call", async (event, eventCtx) => {
    if (event.toolName !== "work_finish") return;
    const runId = eventCtx.runId ?? event.runId;
    if (!runId) return;
    return {
      params: {
        ...event.params,
        _dispatchRunId: runId,
      },
    };
  });

  // Wake heartbeat immediately when a worker calls work_finish.
  api.on("after_tool_call", async (event, _eventCtx) => {
    if (!COMPLETION_TOOLS.has(event.toolName)) return;
    ctx.runtime?.system.requestHeartbeatNow({ reason: "work_finish", coalesceMs: 2000 });
    wakeHeartbeat("work_finish").catch(() => {});
  });

  // Apply lifecycle-driven completion when any Fabrica worker run ends, then wake heartbeat.
  api.on("agent_end", async (event, eventCtx) => {
    const sessionKey = eventCtx.sessionKey;
    if (!sessionKey) return;
    const parsed = parseFabricaSessionKey(sessionKey);
    if (!parsed) return;
    if (workspaceDir) {
      handleWorkerAgentEnd({
        sessionKey,
        messages: event.messages,
        workspaceDir,
        runCommand: ctx.runCommand,
        runtime: ctx.runtime as never,
        pluginConfig: ctx.pluginConfig,
      }).catch(() => {});
    }
    ctx.runtime?.system.requestHeartbeatNow({ reason: "agent_end", coalesceMs: 2000 });
    wakeHeartbeat("agent_end").catch(() => {});
  });

  // Record spawn time for accurate duration tracking in subagent-lifecycle-hook.
  api.on("subagent_spawned", async (event, _eventCtx) => {
    const sessionKey = event.childSessionKey;
    if (!sessionKey) return;
    spawnTimes.set(sessionKey, Date.now());
    if (workspaceDir && event.runId) {
      await bindDispatchRunIdBySessionKey(workspaceDir, sessionKey, event.runId).catch(() => {});
    }
  });
}
