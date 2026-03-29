/**
 * worker-context-hook.ts — Inject explicit work_finish instruction into worker system prompts.
 *
 * OpenClaw's minimal system prompt says "your final message will be automatically
 * reported" — workers misread this as permission to skip calling work_finish.
 * This hook prepends a clear instruction that overrides that framing.
 *
 * Fires for every agent run (before_agent_start). No-op for non-worker sessions.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginContext } from "../context.js";
import { parseFabricaSessionKey } from "./bootstrap-hook.js";

const WORK_FINISH_CONTEXT = `## Task Completion

When you have finished your task, you MUST call the \`work_finish\` tool to signal completion.
Do NOT rely on your session ending automatically — you must explicitly call \`work_finish\`.
This is required for the pipeline to advance to the next stage.
`;

export function registerWorkerContextHook(
  api: OpenClawPluginApi,
  _ctx: PluginContext,
): void {
  api.on("before_agent_start", async (_event, eventCtx) => {
    const sessionKey = eventCtx.sessionKey;
    if (!sessionKey) return;

    const parsed = parseFabricaSessionKey(sessionKey);
    if (!parsed) return;

    return { prependSystemContext: WORK_FINISH_CONTEXT };
  });
}
