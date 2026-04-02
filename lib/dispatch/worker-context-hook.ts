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

const DEVELOPER_COMPLETION_CONTEXT = `## Task Completion

When you finish, end your response with exactly one final result line in plain text:
- \`Work result: DONE\`
- \`Work result: BLOCKED\`

Do not rely on tool availability to conclude the task. The orchestrator reads this final line directly from your response.
`;

const TESTER_COMPLETION_CONTEXT = `## Task Completion

When you finish, end your response with exactly one final result line in plain text:
- \`Test result: PASS\`
- \`Test result: FAIL\`
- \`Test result: FAIL_INFRA\`
- \`Test result: REFINE\`
- \`Test result: BLOCKED\`

Do not rely on tool availability to conclude the task. The orchestrator reads this final line directly from your response.
`;

const ARCHITECT_COMPLETION_CONTEXT = `## Task Completion

When you finish, end your response with exactly one final result line in plain text:
- \`Architecture result: DONE\`
- \`Architecture result: BLOCKED\`

Do not rely on tool availability to conclude the task. The orchestrator reads this final line directly from your response.
`;

const REVIEWER_COMPLETION_CONTEXT = `## Task Completion

When you finish the review, signal completion by ending your response with the decision line below.
End your response with exactly one decision line in plain text:
- \`Review result: APPROVE\`
- \`Review result: REJECT\`

The orchestrator reads that line directly from your response and advances the review stage automatically.
If you need the project slug for follow-up tools such as \`task_create\`, use the value from the \`Channel:\` line in the task message.
`;

const EXECUTION_CONTRACT_CONTEXT = `## Execution Contract

You must execute the task directly in the assigned worktree execution path.
Do not delegate implementation, testing, review, or planning to another coding agent.
Do not use nested coding agents.
Do not use planning or meta-skills such as brainstorming, writing-plans, or coding-agent.
Do not spawn, supervise, or instruct another agent to do the work for you.
If you cannot proceed directly in the assigned worktree, end with your role's canonical blocked or reject result line.
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
      prependSystemContext: getCompletionContext(parsed.role),
    };
  });
}

function getCompletionContext(role: string): string {
  const executionContract = EXECUTION_CONTRACT_CONTEXT;
  switch (role) {
    case "reviewer":
      return `${executionContract}\n${REVIEWER_COMPLETION_CONTEXT}`;
    case "tester":
      return `${executionContract}\n${TESTER_COMPLETION_CONTEXT}`;
    case "architect":
      return `${executionContract}\n${ARCHITECT_COMPLETION_CONTEXT}`;
    case "developer":
    default:
      return `${executionContract}\n${DEVELOPER_COMPLETION_CONTEXT}`;
  }
}
