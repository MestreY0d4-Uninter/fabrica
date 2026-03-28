/**
 * session.ts — Session management helpers for dispatch.
 */
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { RunCommand } from "../context.js";
import type { EffortLevel } from "../roles/types.js";
import { log as auditLog } from "../audit.js";
import { fetchGatewaySessions } from "../services/gateway-sessions.js";
import { recordIssueLifecycle } from "../projects/index.js";

const GATEWAY_SESSION_LABEL_MAX = 64;
const SESSION_CONFIRM_ATTEMPTS = 5;
const SESSION_CONFIRM_DELAY_MS = 250;

// ---------------------------------------------------------------------------
// Context budget management
// ---------------------------------------------------------------------------

/**
 * Determine whether a session should be cleared based on context budget.
 *
 * Rules:
 * - If same issue (feedback cycle), keep session — worker needs prior context
 * - If context ratio exceeds sessionContextBudget, clear
 */
export async function shouldClearSession(
  sessionKey: string,
  slotIssueId: string | null,
  newIssueId: number,
  timeouts: import("../config/types.js").ResolvedTimeouts,
  workspaceDir: string,
  projectName: string,
  runCommand: RunCommand,
): Promise<boolean> {
  // Don't clear if re-dispatching for the same issue (feedback cycle)
  if (slotIssueId && String(newIssueId) === String(slotIssueId)) {
    return false;
  }

  // Check context budget via gateway session data
  try {
    const sessions = await fetchGatewaySessions(undefined, runCommand);
    if (!sessions) return false; // Gateway unavailable — don't clear

    const session = sessions.get(sessionKey);
    if (!session) return false; // Session not found — will be spawned fresh anyway

    const ratio = session.percentUsed / 100;
    if (ratio > timeouts.sessionContextBudget) {
      await auditLog(workspaceDir, "session_budget_reset", {
        project: projectName,
        sessionKey,
        reason: "context_budget",
        percentUsed: session.percentUsed,
        threshold: timeouts.sessionContextBudget * 100,
        totalTokens: session.totalTokens,
        contextTokens: session.contextTokens,
      });
      return true;
    }
  } catch {
    // Gateway query failed — don't clear, let dispatch proceed normally
  }

  return false;
}

// ---------------------------------------------------------------------------
// Private helpers — exist so dispatchTask reads as a sequence of steps
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget session creation/update.
 * Session key is deterministic, so we don't need to wait for confirmation.
 * If this fails, health check will catch orphaned state later.
 */
export function ensureSessionFireAndForget(
  sessionKey: string,
  model: string,
  workspaceDir: string,
  runCommand: RunCommand,
  timeoutMs = 30_000,
  label?: string,
  lifecycle?: { slug: string; issueId: number },
): void {
  const rc = runCommand;
  const params: Record<string, unknown> = { key: sessionKey, model };
  const normalizedLabel = normalizeGatewaySessionLabel(label);
  if (normalizedLabel.label) params.label = normalizedLabel.label;
  if (normalizedLabel.truncated && normalizedLabel.fullLabel) {
    auditLog(workspaceDir, "session_label_truncated", {
      sessionKey,
      maxLength: GATEWAY_SESSION_LABEL_MAX,
      sessionLabel: normalizedLabel.label,
      sessionLabelFull: normalizedLabel.fullLabel,
    }).catch(() => {});
  }
  rc(
    ["openclaw", "gateway", "call", "sessions.patch", "--params", JSON.stringify(params)],
    { timeoutMs },
  )
    .then(async () => {
      if (!lifecycle) return;
      await recordIssueLifecycle({
        workspaceDir,
        slug: lifecycle.slug,
        issueId: lifecycle.issueId,
        stage: "session_patched",
        sessionKey,
      }).catch(() => {});
    })
    .catch((err) => {
      auditLog(workspaceDir, "dispatch_warning", {
        step: "ensureSession", sessionKey,
        ...(normalizedLabel.label ? { sessionLabel: normalizedLabel.label } : {}),
        ...(normalizedLabel.fullLabel ? { sessionLabelFull: normalizedLabel.fullLabel } : {}),
        error: (err as Error).message ?? String(err),
      }).catch(() => {});
    });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureSessionReady(
  sessionKey: string,
  model: string,
  workspaceDir: string,
  runCommand: RunCommand,
  timeoutMs = 30_000,
  label?: string,
  lifecycle?: { slug: string; issueId: number },
  timeouts?: import("../config/types.js").ResolvedTimeouts,
): Promise<void> {
  const params: Record<string, unknown> = { key: sessionKey, model };
  const normalizedLabel = normalizeGatewaySessionLabel(label);
  if (normalizedLabel.label) params.label = normalizedLabel.label;
  if (normalizedLabel.truncated && normalizedLabel.fullLabel) {
    await auditLog(workspaceDir, "session_label_truncated", {
      sessionKey,
      maxLength: GATEWAY_SESSION_LABEL_MAX,
      sessionLabel: normalizedLabel.label,
      sessionLabelFull: normalizedLabel.fullLabel,
    }).catch(() => {});
  }

  try {
    await runCommand(
      ["openclaw", "gateway", "call", "sessions.patch", "--params", JSON.stringify(params)],
      { timeoutMs },
    );
  } catch (err) {
    await auditLog(workspaceDir, "dispatch_warning", {
      step: "ensureSession",
      sessionKey,
      ...(normalizedLabel.label ? { sessionLabel: normalizedLabel.label } : {}),
      ...(normalizedLabel.fullLabel ? { sessionLabelFull: normalizedLabel.fullLabel } : {}),
      error: (err as Error).message ?? String(err),
    }).catch(() => {});
    throw err;
  }

  if (lifecycle) {
    await recordIssueLifecycle({
      workspaceDir,
      slug: lifecycle.slug,
      issueId: lifecycle.issueId,
      stage: "session_patched",
      sessionKey,
    }).catch(() => {});
  }

  const confirmAttempts = timeouts?.sessionConfirmAttempts ?? SESSION_CONFIRM_ATTEMPTS;
  const confirmDelayMs = timeouts?.sessionConfirmDelayMs ?? SESSION_CONFIRM_DELAY_MS;
  for (let attempt = 0; attempt < confirmAttempts; attempt++) {
    const sessions = await fetchGatewaySessions(undefined, runCommand).catch(() => null);
    if (sessions === null) return;
    if (sessions.has(sessionKey)) return;
    if (attempt < confirmAttempts - 1) {
      await sleep(confirmDelayMs);
    }
  }

  await auditLog(workspaceDir, "dispatch_warning", {
    step: "confirmSession",
    sessionKey,
    ...(normalizedLabel.label ? { sessionLabel: normalizedLabel.label } : {}),
    ...(normalizedLabel.fullLabel ? { sessionLabelFull: normalizedLabel.fullLabel } : {}),
    error: "gateway_session_not_confirmed",
    note: "dispatch_continues_without_confirmation",
  }).catch(() => {});
  // Warning only — dispatch continues. Health check will detect dispatch_unconfirmed state.
}

export const EFFORT_PROMPTS: Record<EffortLevel, string> = {
  minimal: "Be concise. Execute the task directly without extensive analysis.",
  standard: "Analyze the task, then execute. Balance thoroughness with efficiency.",
  deep: "Think deeply before acting. Consider edge cases, alternatives, and implications. Take your time.",
};

/**
 * Build the final system prompt by prepending effort calibration before role instructions.
 */
export function buildEffortPrompt(
  effort: EffortLevel | undefined,
  roleInstructions: string | undefined,
): string {
  const effortPrefix = effort ? EFFORT_PROMPTS[effort] : undefined;
  if (effortPrefix && roleInstructions) {
    return `${effortPrefix}\n\n${roleInstructions}`;
  }
  return effortPrefix ?? roleInstructions ?? "";
}

export function sendToAgent(
  sessionKey: string, taskMessage: string,
  opts: { agentId?: string; projectName: string; projectSlug?: string; issueId: number; role: string; level?: string; slotIndex?: number; fromLabel?: string; orchestratorSessionKey?: string; workspaceDir: string; dispatchTimeoutMs?: number; extraSystemPrompt?: string; runCommand: RunCommand; runtime?: PluginRuntime },
): void {
  const idempotencyKey = `fabrica-${opts.projectName}-${opts.issueId}-${opts.role}-${opts.level ?? "unknown"}-${opts.slotIndex ?? 0}-${opts.fromLabel ?? "unknown"}-${sessionKey}`;

  // Prefer in-process dispatch via runtime.subagent.run() — bypasses WebSocket
  // entirely, avoiding the WS handshake timeout caused by event-loop contention
  // during heartbeat ticks.
  if (opts.runtime?.subagent?.run) {
    opts.runtime.subagent.run({
      sessionKey,
      message: taskMessage,
      idempotencyKey,
      lane: "subagent",
      deliver: false,
      ...(opts.extraSystemPrompt ? { extraSystemPrompt: opts.extraSystemPrompt } : {}),
    }).then((result) => {
      auditLog(opts.workspaceDir, "dispatch_agent_sent", {
        step: "sendToAgent", sessionKey,
        issue: opts.issueId, role: opts.role,
        method: "runtime.subagent.run",
        runId: result?.runId ?? null,
      }).catch(() => {});
      // runtime.subagent.run is in-process — the dispatch is confirmed immediately.
      // Record agent_accepted so the health checker doesn't flag this as dispatch_unconfirmed.
      recordIssueLifecycle({
        workspaceDir: opts.workspaceDir,
        slug: opts.projectSlug ?? opts.projectName,
        issueId: opts.issueId,
        stage: "agent_accepted",
        sessionKey,
        details: { method: "runtime.subagent.run" },
      }).catch(() => {});
    }).catch((err) => {
      auditLog(opts.workspaceDir, "dispatch_warning", {
        step: "sendToAgent", sessionKey,
        issue: opts.issueId, role: opts.role,
        method: "runtime.subagent.run",
        error: (err as Error).message ?? String(err),
      }).catch(() => {});
    });
    return;
  }

  // Fallback: subprocess dispatch (for environments without runtime.subagent)
  const rc = opts.runCommand;
  const gatewayParams = JSON.stringify({
    idempotencyKey,
    agentId: opts.agentId ?? "fabrica",
    sessionKey,
    message: taskMessage,
    deliver: false,
    lane: "subagent",
    ...(opts.orchestratorSessionKey ? { spawnedBy: opts.orchestratorSessionKey } : {}),
    ...(opts.extraSystemPrompt ? { extraSystemPrompt: opts.extraSystemPrompt } : {}),
  });
  rc(
    ["openclaw", "gateway", "call", "agent", "--params", gatewayParams, "--expect-final", "--json"],
    { timeoutMs: opts.dispatchTimeoutMs ?? 60_000 },
  ).catch((err) => {
    auditLog(opts.workspaceDir, "dispatch_warning", {
      step: "sendToAgent", sessionKey,
      issue: opts.issueId, role: opts.role,
      method: "subprocess_fallback",
      error: (err as Error).message ?? String(err),
    }).catch(() => {});
  });
}

export function normalizeGatewaySessionLabel(label?: string, maxLength = GATEWAY_SESSION_LABEL_MAX): {
  label?: string;
  fullLabel?: string;
  truncated: boolean;
} {
  if (!label) return { truncated: false };
  if (label.length <= maxLength) {
    return { label, fullLabel: label, truncated: false };
  }
  return {
    label: label.slice(0, maxLength - 3).trimEnd() + "...",
    fullLabel: label,
    truncated: true,
  };
}
