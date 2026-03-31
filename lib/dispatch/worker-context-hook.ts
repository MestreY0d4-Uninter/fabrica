/**
 * worker-context-hook.ts — Inject explicit completion instructions into worker system prompts.
 *
 * OpenClaw's minimal system prompt says "your final message will be automatically
 * reported" — workers misread this as permission to skip explicit completion.
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

const REVIEWER_COMPLETION_CONTEXT = `## Task Completion

When you finish the review, signal completion by ending your response with the decision line below.
End your response with exactly one decision line in plain text:
- \`Review result: APPROVE\`
- \`Review result: REJECT\`

The orchestrator reads that line directly from your response and advances the review stage automatically.
If you need the project slug for follow-up tools such as \`task_create\`, use the value from the \`Channel:\` line in the task message.
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

    return {
      prependSystemContext: parsed.role === "reviewer"
        ? REVIEWER_COMPLETION_CONTEXT
        : WORK_FINISH_CONTEXT,
    };
  });
}
