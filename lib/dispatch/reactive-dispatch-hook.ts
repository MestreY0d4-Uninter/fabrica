/**
 * reactive-dispatch-hook.ts — Immediate heartbeat wake on worker lifecycle events.
 *
 * Three hooks:
 *   1. after_tool_call — when work_finish or review_submit is called, wake the
 *      heartbeat immediately so the next worker is dispatched in <5s instead of 60–120s.
 *   2. agent_end — when any Fabrica worker run ends (with or without work_finish),
 *      wake the heartbeat for immediate triage.
 *   3. subagent_spawned — record spawn timestamp per session key so
 *      subagent-lifecycle-hook can compute accurate durationMs.
 *
 * All hooks are fire-and-forget. Never throw, never block gateway operation.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginContext } from "../context.js";
import { parseFabricaSessionKey } from "./bootstrap-hook.js";

/** Tools whose completion should immediately trigger heartbeat triage. */
const COMPLETION_TOOLS = new Set(["work_finish", "review_submit"]);

/** Spawn timestamps keyed by childSessionKey. Used by subagent-lifecycle-hook for durationMs. */
const spawnTimes = new Map<string, number>();

/** Returns the recorded spawn timestamp for a session key, or undefined if not recorded. */
export function getSpawnTime(sessionKey: string): number | undefined {
  return spawnTimes.get(sessionKey);
}

export function registerReactiveDispatchHooks(
  api: OpenClawPluginApi,
  ctx: PluginContext,
): void {
  // Wake heartbeat immediately when a worker calls work_finish or review_submit.
  api.on("after_tool_call", async (event, _eventCtx) => {
    if (!COMPLETION_TOOLS.has(event.toolName)) return;
    ctx.runtime?.system.requestHeartbeatNow({ reason: "work_finish", coalesceMs: 2000 });
  });

  // Wake heartbeat immediately when any Fabrica worker run ends.
  // Covers the case where work_finish was NOT called — agent_end fires regardless.
  api.on("agent_end", async (_event, eventCtx) => {
    const sessionKey = eventCtx.sessionKey;
    if (!sessionKey) return;
    const parsed = parseFabricaSessionKey(sessionKey);
    if (!parsed) return;
    ctx.runtime?.system.requestHeartbeatNow({ reason: "agent_end", coalesceMs: 2000 });
  });

  // Record spawn time for accurate duration tracking in subagent-lifecycle-hook.
  api.on("subagent_spawned", async (event, _eventCtx) => {
    const sessionKey = event.childSessionKey;
    if (!sessionKey) return;
    spawnTimes.set(sessionKey, Date.now());
  });
}
