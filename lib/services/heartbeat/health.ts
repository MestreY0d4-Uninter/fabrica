/**
 * Health service — worker health checks and auto-fix.
 *
 * Triangulates THREE sources of truth:
 *   1. projects.json — worker state (active, issueId, sessions per level)
 *   2. Issue label — current GitHub/GitLab label (from workflow config)
 *   3. Session state — whether the OpenClaw session exists via gateway status (including abortedLastRun flag)
 *
 * Detection matrix:
 *   | projects.json | Issue label       | Session state           | Action                                    |
 *   |---------------|-------------------|-------------------------|-------------------------------------------|
 *   | active        | Active label      | abortedLastRun: true    | HEAL: Revert to queue + clear session     |
 *   | active        | Active label      | dead/missing            | Deactivate worker, revert to queue        |
 *   | active        | NOT Active label  | any                     | Deactivate worker (moved externally)      |
 *   | active        | Active label      | alive + normal          | Healthy (flag if stale >2h)               |
 *   | inactive      | Active label      | any                     | Revert issue to queue (label stuck)       |
 *   | inactive      | issueId set       | any                     | Clear issueId (warning)                   |
 *   | active        | issue deleted     | any                     | Deactivate worker, clear state            |
 *
 * Session state notes:
 *   - gateway status `sessions.recent` is capped at 10 entries. We avoid this cap by
 *     reading session keys directly from the session files listed in `sessions.paths`.
 *   - Grace period: workers activated within the last GRACE_PERIOD_MS are never
 *     considered session-dead (they may not appear in sessions yet).
 *   - abortedLastRun: indicates session hit context limit (#287, #290) — triggers immediate healing.
 */
import type { StateLabel, IssueProvider, Issue } from "../../providers/provider.js";
import { PrState } from "../../providers/provider.js";
import {
  getRoleWorker,
  readProjects,
  getProject,
  getIssueRuntime,
  updateSlot,
  updateIssueRuntime,
  deactivateWorker,
  type Project,
} from "../../projects/index.js";
import { diagnoseStall } from "./diagnostic.js";
import { log as auditLog } from "../../audit.js";
import {
  DEFAULT_WORKFLOW,
  getActiveLabel,
  getRevertLabel,
  getQueueLabels,
  getStateLabels,
  hasWorkflowStates,
  getCurrentStateLabel,
  isOwnedByOrUnclaimed,
  isFeedbackState,
  getCompletionRule,
  type WorkflowConfig,
  type Role,
} from "../../workflow/index.js";
import { isSessionAlive, type SessionLookup } from "../gateway-sessions.js";
import { sendToAgent } from "../../dispatch/session.js";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { RunCommand } from "../../context.js";
import { withCorrelationContext } from "../../observability/context.js";
import { withTelemetrySpan } from "../../observability/telemetry.js";
import { resilientLabelTransition } from "../../workflow/labels.js";

// Re-export for consumers that import from health.ts
export { fetchGatewaySessions, isSessionAlive, type GatewaySession, type SessionLookup } from "../gateway-sessions.js";

/** Grace period: skip session-dead checks for workers started within this window.
 * Now configurable via resolvedConfig.timeouts.healthGracePeriodMs — fallback default preserved for callers without config. */
export const GRACE_PERIOD_MS = 5 * 60 * 1_000; // 5 minutes (enough for dispatch + LLM bootstrap; was 15 min which masked dead subagents)

/** Dispatch confirm timeout: flag dispatches that were never acknowledged by the worker.
 * Now configurable via resolvedConfig.timeouts.dispatchConfirmTimeoutMs — fallback default preserved for callers without config. */
export const DISPATCH_CONFIRMATION_TIMEOUT_MS = 2 * 60 * 1_000; // 2 minutes

/** Message sent to nudge a stalled session back to life. */
const NUDGE_MESSAGE = `You appear to have stalled. Continue working on your current task. If you are blocked or unable to proceed, call work_finish with result "blocked".`;

/**
 * Maximum consecutive stall nudges before treating the slot as model-unresponsive.
 * When a model provider is quota-exhausted or returning empty responses, the session
 * receives nudges but never produces output. After MAX_STALL_NUDGES the slot is
 * deactivated and the issue is requeued, preventing an infinite stall-nudge loop.
 */
const MAX_STALL_NUDGES = 3;

/**
 * Maximum dispatch attempts before the issue is moved to a HOLD state.
 * Prevents infinite dispatch loops when workers consistently fail to complete.
 */
const MAX_DISPATCH_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HealthIssue = {
  type:
    | "session_dead"         // Case 1: active worker but session missing/dead
    | "label_mismatch"       // Case 2: active worker but issue not in active label
    | "stale_worker"         // Case 3: active for >2h
    | "stuck_label"          // Case 4: inactive but issue still has active label
    | "orphan_issue_id"      // Case 5: inactive but issueId set
    | "issue_gone"           // Case 6: active but issue deleted/inaccessible
    | "issue_closed"         // Case 6b: active but issue closed externally
    | "orphaned_label"       // Case 7: active label but no worker tracking it
    | "context_overflow"     // Case 1c: active worker but session hit context limit (abortedLastRun)
    | "session_exhausted"   // Case 1d: active worker session near 100% context without work_finish
    | "session_stalled"     // Active worker but session inactive for >stallTimeoutMinutes
    | "dispatch_unconfirmed" // Active worker never reached agent bootstrap/activity after dispatch
    | "stateless_issue"      // Case 8: open managed issue with no state label (#473)
    | "model_unresponsive"   // Slot deactivated after MAX_STALL_NUDGES — model/provider quota exhausted
    | "diagnostic_transition_to_review"   // Diagnostic-first: PR exists + QA passing → move to review
    | "diagnostic_redispatch_same_level"  // Diagnostic-first: PR exists but QA failing → redispatch
    | "diagnostic_nudge_open_pr"          // Diagnostic-first: branch commits but no PR → nudge
    | "diagnostic_log_infra"              // Diagnostic-first: session dead, no artifacts → log infra
    | "diagnostic_escalate_level"         // Diagnostic-first: active session without commits → escalate
    | "diagnostic_retry_infra"            // Diagnostic-first: infra issue, retry
    | "diagnostic_needs_human_review";    // Diagnostic-first: repeated stall, no artifacts → human review
  severity: "critical" | "warning";
  project: string;
  projectSlug: string;
  role: Role;
  message: string;
  level?: string | null;
  sessionKey?: string | null;
  hoursActive?: number;
  issueId?: string | null;
  expectedLabel?: string;
  actualLabel?: string | null;
  slotIndex?: number;
};

export type HealthFix = {
  issue: HealthIssue;
  fixed: boolean;
  labelReverted?: string;
  labelRevertFailed?: boolean;
  nudgeSent?: boolean;
};

type HealthFixAppliedDetails = {
  action: string;
  fromLabel?: string | null;
  toLabel?: string | null;
  idleMinutes?: number;
  deliveryState?: "unknown" | "activity_seen";
};

async function auditHealthFixApplied(
  workspaceDir: string,
  fix: HealthFix,
  details: HealthFixAppliedDetails,
): Promise<void> {
  if (!fix.fixed) return;
  await withCorrelationContext({
    issueId: fix.issue.issueId ?? undefined,
    sessionKey: fix.issue.sessionKey ?? undefined,
    phase: "heartbeat-recovery",
  }, () => withTelemetrySpan("fabrica.recovery.attempt", {
    issueId: fix.issue.issueId ?? undefined,
    sessionKey: fix.issue.sessionKey ?? undefined,
    phase: "heartbeat-recovery",
    reason: fix.issue.type,
    action: details.action,
  }, async () => {
    await auditLog(workspaceDir, "health_fix_applied", {
      type: fix.issue.type,
      reason: fix.issue.type,
      severity: fix.issue.severity,
      project: fix.issue.project,
      projectSlug: fix.issue.projectSlug,
      role: fix.issue.role,
      level: fix.issue.level ?? null,
      issueId: fix.issue.issueId ?? null,
      sessionKey: fix.issue.sessionKey ?? null,
      slotIndex: fix.issue.slotIndex ?? null,
      action: details.action,
      from: details.fromLabel ?? fix.issue.actualLabel ?? null,
      to: details.toLabel ?? fix.issue.expectedLabel ?? null,
      fromLabel: details.fromLabel ?? fix.issue.actualLabel ?? null,
      toLabel: details.toLabel ?? fix.issue.expectedLabel ?? null,
      idleMinutes: details.idleMinutes ?? null,
      deliveryState: details.deliveryState ?? null,
      labelReverted: fix.labelReverted ?? null,
      nudgeSent: fix.nudgeSent ?? false,
    }).catch(() => {});
  }));
}

// ---------------------------------------------------------------------------
// Issue label lookup
// ---------------------------------------------------------------------------

/**
 * Fetch current issue state from the provider.
 * Returns null if issue doesn't exist or is inaccessible.
 */
async function fetchIssue(
  provider: IssueProvider,
  issueId: number,
): Promise<Issue | null> {
  try {
    return await provider.getIssue(issueId);
  } catch {
    return null; // Issue deleted, closed, or inaccessible
  }
}

/** Check if an issue is closed (GitHub returns "CLOSED", GitLab returns "closed"). */
function isIssueClosed(issue: Issue): boolean {
  return issue.state.toLowerCase() === "closed";
}

/**
 * Determine the correct revert label for an orphaned issue.
 *
 * If the issue has an open PR with feedback (changes requested, comments),
 * revert to the feedback queue ("To Improve") instead of the default queue ("To Do").
 * This prevents feedback cycles from being re-dispatched as fresh tasks.
 */
async function resolveOrphanRevertLabel(
  provider: IssueProvider,
  issueId: number,
  role: Role,
  defaultQueueLabel: string,
  workflow: WorkflowConfig,
): Promise<string> {
  try {
    const prStatus = await provider.getPrStatus(issueId);
    if (prStatus.url && prStatus.state !== PrState.MERGED && prStatus.state !== PrState.CLOSED && prStatus.currentIssueMatch !== false) {
      if (
        prStatus.state === PrState.CHANGES_REQUESTED ||
        prStatus.state === PrState.HAS_COMMENTS
      ) {
        // Feedback cycle → "To Improve"
        const queueLabels = getQueueLabels(workflow, role);
        const feedbackLabel = queueLabels.find((l) => isFeedbackState(workflow, l));
        if (feedbackLabel) return feedbackLabel;
      }
      // Fresh completion (OPEN/APPROVED) → workflow COMPLETE target ("To Review")
      const rule = getCompletionRule(workflow, role, "done");
      if (rule) return rule.to;
    }
  } catch {
    // Best-effort — fall back to default queue on API failure
  }
  return defaultQueueLabel;
}

// ---------------------------------------------------------------------------
// Health check logic
// ---------------------------------------------------------------------------

/**
 * Detect session exhaustion: high context usage without abort flag or completion.
 * Exported for testability (F1-8).
 */
export function isSessionExhausted(session: {
  percentUsed?: number;
  abortedLastRun?: boolean;
  sessionCompletedAt?: string | null;
}): boolean {
  return (
    session.percentUsed !== undefined &&
    session.percentUsed >= 0.98 &&
    !session.abortedLastRun &&
    !session.sessionCompletedAt
  );
}

/**
 * Returns true if the dispatch has not been confirmed within the given timeout.
 * Exported for testability (F2-5).
 */
export function isDispatchUnconfirmed(
  dispatchedAtMs: number,
  timeoutMs: number = DISPATCH_CONFIRMATION_TIMEOUT_MS,
): boolean {
  return Date.now() - dispatchedAtMs > timeoutMs;
}

export async function checkWorkerHealth(opts: {
  workspaceDir: string;
  projectSlug: string;
  project: Project;
  role: Role;
  autoFix: boolean;
  provider: IssueProvider;
  sessions: SessionLookup | null;
  /** Workflow config (defaults to DEFAULT_WORKFLOW) */
  workflow?: WorkflowConfig;
  /** Hours after which an active worker is considered stale (default: 2) */
  staleWorkerHours?: number;
  /** Minutes of session inactivity before stall detection (default: 15) */
  stallTimeoutMinutes?: number;
  /** Required for sending nudge messages to stalled sessions */
  runCommand: RunCommand;
  /** Plugin runtime for in-process agent dispatch (bypasses WS) */
  runtime?: PluginRuntime;
  /** Agent ID for sendToAgent calls */
  agentId?: string;
  /** Configurable dispatch confirmation timeout in ms (default: DISPATCH_CONFIRMATION_TIMEOUT_MS) */
  dispatchConfirmTimeoutMs?: number;
}): Promise<HealthFix[]> {
  const {
    workspaceDir, projectSlug, project, role, autoFix, provider, sessions,
    workflow = DEFAULT_WORKFLOW,
    staleWorkerHours = 2,
    dispatchConfirmTimeoutMs = DISPATCH_CONFIRMATION_TIMEOUT_MS,
  } = opts;

  const fixes: HealthFix[] = [];

  // Skip roles without workflow states (e.g. architect — tool-triggered only)
  if (!hasWorkflowStates(workflow, role)) return fixes;

  const roleWorker = getRoleWorker(project, role);

  // Get labels from workflow config
  const expectedLabel = getActiveLabel(workflow, role);
  const queueLabel = getRevertLabel(workflow, role);

  // Iterate over all levels and their slots
  for (const [level, slots] of Object.entries(roleWorker.levels)) {
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
      const slot = slots[slotIndex]!;
      const sessionKey = slot.sessionKey;

      // Use the label stored at dispatch time (previousLabel) if available
      const slotQueueLabel: string = slot.previousLabel ?? queueLabel;

      // Grace period: skip session liveness checks for recently-started workers
      const workerStartTime = slot.startTime ? new Date(slot.startTime).getTime() : null;
      const withinGracePeriod = workerStartTime !== null && (Date.now() - workerStartTime) < GRACE_PERIOD_MS;

      // Parse issueId
      const issueIdNum = slot.issueId ? Number(slot.issueId) : null;

      // Fetch issue state if we have an issueId
      let issue: Issue | null = null;
      let currentLabel: StateLabel | null = null;
      const issueRuntime = issueIdNum ? getIssueRuntime(project, issueIdNum) : undefined;
      const deliveryState = issueRuntime?.firstWorkerActivityAt ? "activity_seen" : "unknown";
      const dispatchRequestedAt = issueRuntime?.dispatchRequestedAt ? Date.parse(issueRuntime.dispatchRequestedAt) : null;
      const dispatchConfirmed = Boolean(issueRuntime?.agentAcceptedAt || issueRuntime?.firstWorkerActivityAt);
      if (issueIdNum) {
        issue = await fetchIssue(provider, issueIdNum);
        currentLabel = issue ? getCurrentStateLabel(issue.labels, workflow) : null;
      }

      // Helper to revert label for this issue
      async function revertLabel(fix: HealthFix, from: StateLabel, to: StateLabel) {
        if (!issueIdNum) return;
        try {
          await resilientLabelTransition(provider, issueIdNum, from, to);
          fix.labelReverted = `${from} → ${to}`;
        } catch {
          fix.labelRevertFailed = true;
        }
      }

      // Helper to deactivate this slot
      async function deactivateSlot() {
        await deactivateWorker(workspaceDir, projectSlug, role, {
          level,
          slotIndex,
          issueId: slot.issueId ?? undefined,
        });
      }

      // Case 6: Active but issue doesn't exist (deleted/closed externally)
      if (slot.active && issueIdNum && !issue) {
        const fix: HealthFix = {
          issue: {
            type: "issue_gone",
            severity: "critical",
            project: project.name,
            projectSlug,
            role,
            level,
            sessionKey,
            issueId: slot.issueId,
            slotIndex,
            message: `${role.toUpperCase()} ${level}[${slotIndex}] active but issue #${issueIdNum} no longer exists or is closed`,
          },
          fixed: false,
        };
        if (autoFix) {
          await deactivateSlot();
          fix.fixed = true;
          await auditHealthFixApplied(workspaceDir, fix, {
            action: "deactivate_slot",
          });
        }
        fixes.push(fix);
        continue;
      }

      // Case 6b: Active but issue is closed (externally or by another process)
      // getIssue() returns closed issues on GitHub/GitLab, so Case 6 doesn't catch this.
      if (slot.active && issue && isIssueClosed(issue)) {
        const fix: HealthFix = {
          issue: {
            type: "issue_closed",
            severity: "critical",
            project: project.name,
            projectSlug,
            role,
            level,
            sessionKey,
            issueId: slot.issueId,
            slotIndex,
            message: `${role.toUpperCase()} ${level}[${slotIndex}] active but issue #${issueIdNum} is closed`,
          },
          fixed: false,
        };
        if (autoFix) {
          await deactivateSlot();
          fix.fixed = true;
          await auditHealthFixApplied(workspaceDir, fix, {
            action: "deactivate_slot",
          });
        }
        fixes.push(fix);
        continue;
      }

      // Case 2: Active but issue label is NOT the expected in-progress label
      if (slot.active && issue && currentLabel !== expectedLabel) {
        const fix: HealthFix = {
          issue: {
            type: "label_mismatch",
            severity: "critical",
            project: project.name,
            projectSlug,
            role,
            level,
            sessionKey,
            issueId: slot.issueId,
            expectedLabel,
            actualLabel: currentLabel,
            slotIndex,
            message: `${role.toUpperCase()} ${level}[${slotIndex}] active but issue #${issueIdNum} has label "${currentLabel}" (expected "${expectedLabel}")`,
          },
          fixed: false,
        };
        if (autoFix) {
          await deactivateSlot();
          fix.fixed = true;
          await auditHealthFixApplied(workspaceDir, fix, {
            action: "deactivate_slot",
          });
        }
        fixes.push(fix);
        continue;
      }

      // Case 1: Active with correct label but session is dead/missing
      if (slot.active && sessionKey && sessions && !withinGracePeriod && !isSessionAlive(sessionKey, sessions)) {
        const fix: HealthFix = {
          issue: {
            type: "session_dead",
            severity: "critical",
            project: project.name,
            projectSlug,
            role,
            sessionKey,
            level,
            issueId: slot.issueId,
            slotIndex,
            message: `${role.toUpperCase()} ${level}[${slotIndex}] active but session "${sessionKey}" not found in gateway`,
          },
          fixed: false,
        };
        if (autoFix) {
          await revertLabel(fix, expectedLabel, slotQueueLabel);
          if (!fix.labelRevertFailed) {
            await deactivateSlot();
            fix.fixed = true;
            await auditHealthFixApplied(workspaceDir, fix, {
              action: "requeue_issue",
              fromLabel: expectedLabel,
              toLabel: slotQueueLabel,
            });
          }
        }
        fixes.push(fix);
        continue;
      }

      // Case 1b: Active but no session key at all
      if (slot.active && !sessionKey) {
        const fix: HealthFix = {
          issue: {
            type: "session_dead",
            severity: "critical",
            project: project.name,
            projectSlug,
            role,
            level,
            issueId: slot.issueId,
            slotIndex,
            message: `${role.toUpperCase()} ${level}[${slotIndex}] active but no session key`,
          },
          fixed: false,
        };
        if (autoFix) {
          if (issue && currentLabel === expectedLabel) {
            await revertLabel(fix, expectedLabel, slotQueueLabel);
          }
          if (!fix.labelRevertFailed) {
            await deactivateSlot();
            fix.fixed = true;
            await auditHealthFixApplied(workspaceDir, fix, {
              action: "requeue_issue",
              fromLabel: expectedLabel,
              toLabel: slotQueueLabel,
            });
          }
        }
        fixes.push(fix);
        continue;
      }

      // Case 1c: Active with correct label but session hit context limit (abortedLastRun)
      if (slot.active && sessionKey && sessions && isSessionAlive(sessionKey, sessions)) {
        const session = sessions.get(sessionKey);
        if (session?.abortedLastRun) {
          const fix: HealthFix = {
            issue: {
              type: "context_overflow",
              severity: "critical",
              project: project.name,
              projectSlug,
              role,
              sessionKey,
              level,
              issueId: slot.issueId,
              expectedLabel,
              actualLabel: currentLabel,
              slotIndex,
              message: `${role.toUpperCase()} ${level}[${slotIndex}] session "${sessionKey}" hit context limit (abortedLastRun: true). Healing by reverting to queue.`,
            },
            fixed: false,
          };
          if (autoFix) {
            if (issue && currentLabel === expectedLabel) {
              await revertLabel(fix, expectedLabel, slotQueueLabel);
            }
            if (!fix.labelRevertFailed) {
              await deactivateSlot();
              fix.fixed = true;
              await auditHealthFixApplied(workspaceDir, fix, {
                action: "requeue_issue",
                fromLabel: expectedLabel,
                toLabel: slotQueueLabel,
              });
            }
          }
          fixes.push(fix);
          await auditLog(workspaceDir, "context_overflow_healed", {
            project: project.name,
            projectSlug,
            role,
            issueId: slot.issueId,
            sessionKey,
            level,
            slotIndex,
          }).catch(() => {});
          continue;
        }
      }

      // Case 1d: session exhausted (high context usage without abort or completion)
      if (slot.active && sessionKey && sessions && isSessionAlive(sessionKey, sessions)) {
        const session = sessions.get(sessionKey);
        const normalizedSession = session
          ? { ...session, percentUsed: (session.percentUsed ?? 0) / 100 }
          : {};
        if (isSessionExhausted(normalizedSession)) {
          const fix: HealthFix = {
            issue: {
              type: "session_exhausted",
              severity: "warning",
              project: project.name,
              projectSlug,
              role,
              sessionKey,
              level,
              issueId: slot.issueId,
              slotIndex,
              message: `${role.toUpperCase()} ${level}[${slotIndex}] session "${sessionKey}" at ${Math.round(session?.percentUsed ?? 0)}% context without work_finish`,
            },
            fixed: false,
          };
          fixes.push(fix);
        }
      }

      // Case: dispatch was requested but the worker never reached bootstrap/activity.
      if (
        slot.active &&
        issue &&
        currentLabel === expectedLabel &&
        dispatchRequestedAt !== null &&
        !dispatchConfirmed &&
        (Date.now() - dispatchRequestedAt) > dispatchConfirmTimeoutMs
      ) {
        const fix: HealthFix = {
          issue: {
            type: "dispatch_unconfirmed",
            severity: "critical",
            project: project.name,
            projectSlug,
            role,
            sessionKey,
            level,
            issueId: slot.issueId,
            expectedLabel,
            actualLabel: currentLabel,
            slotIndex,
            message: `${role.toUpperCase()} ${level}[${slotIndex}] never reached agent bootstrap after dispatch confirmation window`,
          },
          fixed: false,
        };
        if (autoFix) {
          await revertLabel(fix, expectedLabel, slotQueueLabel);
          if (!fix.labelRevertFailed) {
            await deactivateSlot();
            fix.fixed = true;
            await auditHealthFixApplied(workspaceDir, fix, {
              action: "requeue_issue",
              fromLabel: expectedLabel,
              toLabel: slotQueueLabel,
              deliveryState,
            });
          }
        }
        fixes.push(fix);
        continue;
      }

      // Case: Active with alive session but no recent activity (stalled)
      if (slot.active && sessionKey && sessions && !withinGracePeriod && isSessionAlive(sessionKey, sessions)) {
        const session = sessions.get(sessionKey)!;
        const stallThresholdMs = (opts.stallTimeoutMinutes ?? 5) * 60_000;
        if (session.updatedAt == null) continue;
        const sessionIdleMs = Date.now() - session.updatedAt;

        if (sessionIdleMs > stallThresholdMs) {
          const idleMinutes = Math.round(sessionIdleMs / 60_000);

          // --- Diagnostic-first stall detection (v0.2.0) ---
          // Always run diagnostic on first stall detection.  Workers spawned via
          // runtime.subagent.run() may not have access to plugin tools like
          // work_finish, so nudging them is often ineffective.  Instead, check for
          // real deliverables (PR, commits, CI status) and act on evidence.
          // Extract owner/repo from repoRemote URL (e.g. "https://github.com/Org/repo.git")
          const repoRemote: string = (project as any).repoRemote ?? "";
          const remoteMatch = repoRemote.match(/github\.com\/([^/]+)\/([^/.]+)/);
          const diagnostic = await diagnoseStall({
            projectSlug,
            owner: remoteMatch?.[1] ?? "",
            repo: remoteMatch?.[2] ?? "",
            issueId: issueIdNum ?? 0,
            sessionKey,
            slotStartTime: slot.startTime ? new Date(slot.startTime).getTime() : Date.now() - sessionIdleMs,
            sessionUpdatedAt: session.updatedAt,
            dispatchAttemptCount: issueRuntime?.dispatchAttemptCount ?? 0,
          });

          // Actions that indicate the worker produced deliverables — act immediately
          const evidenceActions = ["transition_to_review", "nudge_open_pr"];
          const hasActionableEvidence = evidenceActions.includes(diagnostic.action);

          // Model-unresponsive check: after MAX_STALL_NUDGES intervals, escalate
          // regardless of diagnostic result (infinite nudge loop prevention).
          const modelUnresponsiveMs = stallThresholdMs * MAX_STALL_NUDGES;
          const slotAgeMs = slot.startTime ? Date.now() - new Date(slot.startTime).getTime() : sessionIdleMs;
          const isModelUnresponsive = slotAgeMs > modelUnresponsiveMs;

          // Circuit breaker: after MAX_DISPATCH_ATTEMPTS, move to HOLD state
          // to prevent infinite dispatch loops when workers consistently fail.
          const currentAttempts = issueRuntime?.dispatchAttemptCount ?? 0;
          if (currentAttempts >= MAX_DISPATCH_ATTEMPTS && !hasActionableEvidence) {
            const fix: HealthFix = {
              issue: {
                type: "diagnostic_needs_human_review",
                severity: "critical",
                project: project.name,
                projectSlug,
                role,
                level,
                sessionKey,
                issueId: slot.issueId,
                slotIndex,
                message: `${role.toUpperCase()} ${level}[${slotIndex}] circuit breaker: ${currentAttempts} dispatch attempts without completion — moving to Refining`,
              },
              fixed: false,
            };
            if (autoFix) {
              await revertLabel(fix, expectedLabel, "Refining");
              await deactivateSlot();
              fix.fixed = true;
            }
            await auditLog(workspaceDir, "dispatch_circuit_breaker", {
              project: project.name, projectSlug, role, level, sessionKey,
              issueId: slot.issueId, slotIndex, dispatchAttemptCount: currentAttempts,
              diagnostic: diagnostic.action, evidence: diagnostic.evidence,
            }).catch(() => {});
            fixes.push(fix);
            continue;
          }

          if (hasActionableEvidence || isModelUnresponsive) {
            // Act on diagnostic — either evidence-based or timeout-escalation

            // Update issue runtime state with diagnostic result.
            // If a PR was discovered, auto-bind it so queue_pr_guard passes.
            // This is necessary because workers may not have access to work_finish
            // and the PR would otherwise remain unbound.
            if (issueIdNum) {
              const runtimeUpdate: Record<string, unknown> = {
                lastDiagnosticResult: diagnostic.evidence,
                lastFailureReason: diagnostic.reason,
                dispatchAttemptCount: (issueRuntime?.dispatchAttemptCount ?? 0) + 1,
              };
              if (diagnostic.prNumber) {
                const prOwner = remoteMatch?.[1] ?? "";
                const prRepo = remoteMatch?.[2] ?? "";
                runtimeUpdate.currentPrNumber = diagnostic.prNumber;
                runtimeUpdate.currentPrUrl = `https://github.com/${prOwner}/${prRepo}/pull/${diagnostic.prNumber}`;
                runtimeUpdate.currentPrState = "open";
                runtimeUpdate.bindingSource = "diagnostic";
                runtimeUpdate.bindingConfidence = "high";
                runtimeUpdate.boundAt = new Date().toISOString();
              }
              await updateIssueRuntime(workspaceDir, projectSlug, String(issueIdNum), runtimeUpdate).catch(() => {});
            }

            const diagnosticType = `diagnostic_${diagnostic.action}` as HealthIssue["type"];
            const fix: HealthFix = {
              issue: {
                type: diagnosticType,
                severity: diagnostic.action === "needs_human_review" ? "critical" : "warning",
                project: project.name,
                projectSlug,
                role,
                level,
                sessionKey,
                issueId: slot.issueId,
                slotIndex,
                message: `${role.toUpperCase()} ${level}[${slotIndex}] stall diagnosed: ${diagnostic.action} — ${diagnostic.evidence}`,
              },
              fixed: false,
            };

            if (autoFix) {
              switch (diagnostic.action) {
                case "transition_to_review": {
                  // Role-aware transition: diagnostic says "PR exists, QA passing"
                  // but the correct next state depends on WHO stalled:
                  //   developer → "To Review" (standard: dev done, send to reviewer)
                  //   reviewer  → "To Test"   (reviewer done, advance to tester)
                  //   tester    → "Done"       (tester done, pipeline complete)
                  const targetLabel =
                    role === "tester" ? "Done" :
                    role === "reviewer" ? "To Test" :
                    "To Review";
                  await revertLabel(fix, expectedLabel, targetLabel);
                  if (!fix.labelRevertFailed) {
                    await deactivateSlot();
                    // If tester completed, close the issue (terminal transition)
                    if (role === "tester" && issueIdNum) {
                      await provider.closeIssue(issueIdNum).catch(() => {});
                    }
                    fix.fixed = true;
                  }
                  break;
                }

                case "redispatch_same_level":
                case "nudge_open_pr":
                case "retry_infra":
                  await revertLabel(fix, expectedLabel, slotQueueLabel);
                  if (!fix.labelRevertFailed) {
                    await deactivateSlot();
                    fix.fixed = true;
                  }
                  break;

                case "escalate_level":
                  await revertLabel(fix, expectedLabel, slotQueueLabel);
                  if (!fix.labelRevertFailed) {
                    await deactivateSlot();
                    fix.fixed = true;
                  }
                  break;

                case "needs_human_review":
                  // Move to HOLD state to prevent re-dispatch loop.
                  // Without label change, heartbeat would see active label
                  // with no worker and re-dispatch indefinitely.
                  await revertLabel(fix, expectedLabel, "Refining");
                  await deactivateSlot();
                  fix.fixed = true;
                  break;

                case "log_infra":
                  // Move to HOLD state — infrastructure issue, no artifacts.
                  await revertLabel(fix, expectedLabel, "Refining");
                  await deactivateSlot();
                  fix.fixed = true;
                  break;
              }
            }

            await auditLog(workspaceDir, "stall_diagnostic", {
              project: project.name, projectSlug, role, level, sessionKey,
              issueId: slot.issueId, slotIndex, idleMinutes,
              diagnostic: diagnostic.action,
              reason: diagnostic.reason,
              evidence: diagnostic.evidence,
              fastPath: hasActionableEvidence,
              dispatchAttemptCount: (issueRuntime?.dispatchAttemptCount ?? 0) + 1,
            }).catch(() => {});

            fixes.push(fix);
            continue;
          }

          // No deliverables found yet — nudge the worker as fallback
          const fix: HealthFix = {
            issue: {
              type: "session_stalled",
              severity: "critical",
              project: project.name,
              projectSlug,
              role,
              level,
              sessionKey,
              issueId: slot.issueId,
              slotIndex,
              message: `${role.toUpperCase()} ${level}[${slotIndex}] session idle ${idleMinutes}m — no deliverables yet, sending nudge`,
            },
            fixed: false,
          };

          if (autoFix) {
            sendToAgent(sessionKey, NUDGE_MESSAGE, {
              agentId: opts.agentId,
              projectName: project.name,
              issueId: issueIdNum!,
              role,
              level,
              slotIndex,
              workspaceDir,
              runCommand: opts.runCommand,
              runtime: opts.runtime,
            });
            fix.nudgeSent = true;
            fix.fixed = true;
            await auditHealthFixApplied(workspaceDir, fix, {
              action: "nudge_session",
              idleMinutes,
              deliveryState,
            });
          }

          await auditLog(workspaceDir, "session_stalled", {
            project: project.name,
            projectSlug,
            role,
            level,
            sessionKey,
            issueId: slot.issueId,
            slotIndex,
            idleMinutes,
            deliveryState,
            action: "nudge",
          }).catch(() => {});
          fixes.push(fix);
          continue;
        }
      }

      // Case 3: Active with correct label and alive session — check for staleness
      if (slot.active && slot.startTime && sessionKey && sessions && isSessionAlive(sessionKey, sessions)) {
        const hours = (Date.now() - new Date(slot.startTime).getTime()) / 3_600_000;
        if (hours > staleWorkerHours) {
          const fix: HealthFix = {
            issue: {
              type: "stale_worker",
              severity: "warning",
              project: project.name,
              projectSlug,
              role,
              hoursActive: Math.round(hours * 10) / 10,
              sessionKey,
              issueId: slot.issueId,
              slotIndex,
              message: `${role.toUpperCase()} ${level}[${slotIndex}] active for ${Math.round(hours * 10) / 10}h — may need attention`,
            },
            fixed: false,
          };
          if (autoFix) {
            await revertLabel(fix, expectedLabel, slotQueueLabel);
            if (!fix.labelRevertFailed) {
              await deactivateSlot();
              fix.fixed = true;
              await auditHealthFixApplied(workspaceDir, fix, {
                action: "requeue_issue",
                fromLabel: expectedLabel,
                toLabel: slotQueueLabel,
              });
            }
          }
          fixes.push(fix);
        }
      }

      // Case 4: Inactive but issue has stuck active label
      if (!slot.active && issue && currentLabel === expectedLabel) {
        const fix: HealthFix = {
          issue: {
            type: "stuck_label",
            severity: "critical",
            project: project.name,
            projectSlug,
            role,
            issueId: slot.issueId,
            expectedLabel: slotQueueLabel,
            actualLabel: currentLabel,
            slotIndex,
            message: `${role.toUpperCase()} ${level}[${slotIndex}] inactive but issue #${issueIdNum} still has "${currentLabel}" label`,
          },
          fixed: false,
        };
        if (autoFix) {
          await revertLabel(fix, expectedLabel, slotQueueLabel);
          if (!fix.labelRevertFailed) {
            // Clear the slot's issueId
            if (slot.issueId) {
              await updateSlot(workspaceDir, projectSlug, role, level, slotIndex, { issueId: null });
            }
            fix.fixed = true;
            await auditHealthFixApplied(workspaceDir, fix, {
              action: "revert_stuck_label",
              fromLabel: expectedLabel,
              toLabel: slotQueueLabel,
            });
          }
        }
        fixes.push(fix);
        continue;
      }

      // Case 5: Inactive but still has issueId set (orphan reference)
      if (!slot.active && slot.issueId) {
        const fix: HealthFix = {
          issue: {
            type: "orphan_issue_id",
            severity: "warning",
            project: project.name,
            projectSlug,
            role,
            issueId: slot.issueId,
            slotIndex,
            message: `${role.toUpperCase()} ${level}[${slotIndex}] inactive but still has issueId "${slot.issueId}"`,
          },
          fixed: false,
        };
        if (autoFix) {
          await updateSlot(workspaceDir, projectSlug, role, level, slotIndex, { issueId: null });
          fix.fixed = true;
          await auditHealthFixApplied(workspaceDir, fix, {
            action: "clear_orphan_issue_id",
          });
        }
        fixes.push(fix);
      }
    }
  }

  return fixes;
}
// ---------------------------------------------------------------------------
// Dispatch progress tracking
// ---------------------------------------------------------------------------

export type ProgressCheck = {
  lastCommitAgeMs: number;
  sessionActive: boolean;
};

const SLOW_PROGRESS_MS = 30 * 60_000;
const STALLED_MS = 60 * 60_000;

/**
 * Classify dispatch progress based on commit activity.
 */
export function checkProgress(check: ProgressCheck): "healthy" | "slow_progress" | "stalled" {
  if (!check.sessionActive) return "healthy";
  if (check.lastCommitAgeMs > STALLED_MS) return "stalled";
  if (check.lastCommitAgeMs > SLOW_PROGRESS_MS) return "slow_progress";
  return "healthy";
}

// ---------------------------------------------------------------------------
// Orphaned label scan
// ---------------------------------------------------------------------------

/**
 * Scan for issues with active labels (Doing, Testing) that are NOT tracked
 * in projects.json. This catches cases where:
 * - Worker crashed and state was cleared (issueId: null)
 * - Label was set externally
 * - State corruption
 *
 * Returns fixes for all orphaned labels found.
 */
export async function scanOrphanedLabels(opts: {
  workspaceDir: string;
  projectSlug: string;
  project: Project;
  role: Role;
  autoFix: boolean;
  provider: IssueProvider;
  /** Workflow config (defaults to DEFAULT_WORKFLOW) */
  workflow?: WorkflowConfig;
  /** Instance name for ownership filtering. Only processes issues owned by this instance or unclaimed. */
  instanceName?: string;
}): Promise<HealthFix[]> {
  const {
    workspaceDir, projectSlug, project, role, autoFix, provider,
    workflow = DEFAULT_WORKFLOW,
    instanceName,
  } = opts;

  const fixes: HealthFix[] = [];

  // Skip roles without workflow states (e.g. architect — tool-triggered only)
  if (!hasWorkflowStates(workflow, role)) return fixes;

  // Re-read projects.json from disk to avoid stale snapshot.
  // The heartbeat reads projects once per tick, but work_finish may have
  // deactivated a slot between then and now — using the stale snapshot
  // causes false-positive orphan detection.
  let freshProject: Project;
  try {
    const data = await readProjects(workspaceDir);
    freshProject = getProject(data, projectSlug) ?? project;
  } catch {
    freshProject = project; // Fall back to stale snapshot on read failure
  }

  const roleWorker = getRoleWorker(freshProject, role);

  // Get labels from workflow config
  const activeLabel = getActiveLabel(workflow, role);
  const queueLabel = getRevertLabel(workflow, role);

  // Fetch all issues with the active label
  let issuesWithLabel: Issue[];
  try {
    issuesWithLabel = await provider.listIssuesByLabel(activeLabel);
  } catch {
    // Provider error (timeout, network, etc) — skip this scan
    return fixes;
  }

  // Filter by ownership: only process issues owned by this instance or unclaimed
  const ownedIssues = instanceName
    ? issuesWithLabel.filter((i) => isOwnedByOrUnclaimed(i.labels, instanceName))
    : issuesWithLabel;

  // Check each issue to see if it's tracked in any slot across all levels
  for (const issue of ownedIssues) {
    const issueIdStr = String(issue.iid);

    let isTracked = false;
    for (const slots of Object.values(roleWorker.levels)) {
      if (slots.some(slot => slot.active && slot.issueId === issueIdStr)) {
        isTracked = true;
        break;
      }
    }

    if (!isTracked) {
      // Grace period: skip orphan detection if any slot was recently activated.
      // This prevents the C2 race where dispatch writes the worker state and
      // then transitions the label — if this scan runs in between, the slot
      // exists but may not yet have the matching issueId visible.
      const ORPHAN_GRACE_MS = 30_000;
      const now = Date.now();
      let recentlyActivated = false;
      for (const slots of Object.values(roleWorker.levels)) {
        if (slots.some(slot => {
          if (!slot.startTime) return false;
          const age = now - new Date(slot.startTime).getTime();
          return age < ORPHAN_GRACE_MS;
        })) {
          recentlyActivated = true;
          break;
        }
      }
      if (recentlyActivated) continue; // Skip — dispatch may still be in progress

      // Orphaned label: issue has active label but no slot tracking it.
      // Re-fetch the issue to guard against GitHub propagation delay:
      // session_dead may have already transitioned the label moments ago,
      // but listIssuesByLabel() returned a stale result. Confirm the active
      // label is still present before acting to avoid a double-transition.
      let confirmedActiveLabel = false;
      try {
        const freshIssue = await provider.getIssue(issue.iid);
        const freshLabel = freshIssue ? getCurrentStateLabel(freshIssue.labels, workflow) : null;
        confirmedActiveLabel = freshLabel === activeLabel;
      } catch {
        // If we can't confirm, skip this orphan rather than risk a false transition.
        continue;
      }
      if (!confirmedActiveLabel) continue; // label already changed — not orphaned

      const fix: HealthFix = {
        issue: {
          type: "orphaned_label",
          severity: "critical",
          project: project.name,
          projectSlug,
          role,
          issueId: issueIdStr,
          expectedLabel: queueLabel,
          actualLabel: activeLabel,
          message: `Issue #${issue.iid} has "${activeLabel}" label but no ${role.toUpperCase()} slot is tracking it`,
        },
        fixed: false,
      };

      if (autoFix) {
        try {
          const revertTarget = await resolveOrphanRevertLabel(
            provider, issue.iid, role, queueLabel, workflow,
          );
          await resilientLabelTransition(provider, issue.iid, activeLabel, revertTarget);
          fix.fixed = true;
          fix.labelReverted = `${activeLabel} → ${revertTarget}`;
          fix.issue.expectedLabel = revertTarget;
          await auditHealthFixApplied(workspaceDir, fix, {
            action: "revert_orphaned_label",
            fromLabel: activeLabel,
            toLabel: revertTarget,
          });
        } catch {
          fix.labelRevertFailed = true;
        }
      }

      fixes.push(fix);
    }
  }

  return fixes;
}

/**
 * Scan for open, Fabrica-managed issues that have lost their state label.
 * These issues are invisible to the queue scanner and effectively stuck.
 *
 * Detection: open issue has workflow-related labels but zero state labels.
 * Recovery: restore to initial state (e.g. "Planning") so operator can re-triage.
 * See #473 for the root cause analysis.
 */
export async function scanStatelessIssues(opts: {
  workspaceDir: string;
  projectSlug: string;
  project: Project;
  provider: IssueProvider;
  workflow?: WorkflowConfig;
  autoFix: boolean;
  instanceName?: string;
}): Promise<HealthFix[]> {
  const {
    workspaceDir, projectSlug, project, provider,
    workflow = DEFAULT_WORKFLOW,
    autoFix,
    instanceName,
  } = opts;

  const fixes: HealthFix[] = [];
  const stateLabels = getStateLabels(workflow);
  const initialLabel = workflow.states[workflow.initial]?.label;
  if (!initialLabel) return fixes;

  // Fetch all open issues and filter client-side for missing state labels
  let allOpenIssues: Issue[];
  try {
    allOpenIssues = await provider.listIssues({ state: "open" });
  } catch {
    return fixes; // Provider error — skip this scan
  }

  for (const issue of allOpenIssues) {
    const hasStateLabel = issue.labels.some((l) => stateLabels.includes(l));
    if (hasStateLabel) continue;

    // Only flag Fabrica-managed issues (have workflow labels like role:*, review:*, etc.)
    const hasWorkflowLabels = issue.labels.some((l) =>
      l.startsWith("developer:") || l.startsWith("tester:") || l.startsWith("reviewer:") ||
      l.startsWith("architect:") || l.startsWith("review:") || l.startsWith("test:") ||
      l.startsWith("owner:") || l.startsWith("notify:"),
    );
    if (!hasWorkflowLabels) continue;

    // Ownership filter
    if (instanceName && !isOwnedByOrUnclaimed(issue.labels, instanceName)) continue;

    const fix: HealthFix = {
      issue: {
        type: "stateless_issue",
        severity: "critical",
        project: project.name,
        projectSlug,
        role: "developer" as Role,
        issueId: String(issue.iid),
        expectedLabel: initialLabel,
        actualLabel: null,
        message: `Issue #${issue.iid} has no state label — invisible to queue scanner. Labels: [${issue.labels.join(", ")}]`,
      },
      fixed: false,
    };

    if (autoFix) {
      try {
        await provider.ensureLabel(initialLabel, "");
        await provider.addLabel(issue.iid, initialLabel);
        fix.fixed = true;
        fix.labelReverted = `(none) → ${initialLabel}`;

        await auditLog(workspaceDir, "stateless_issue_recovered", {
          project: project.name,
          issueId: issue.iid,
          restoredTo: initialLabel,
          originalLabels: issue.labels,
        });
        await auditHealthFixApplied(workspaceDir, fix, {
          action: "restore_initial_state",
          fromLabel: null,
          toLabel: initialLabel,
        });
      } catch {
        fix.labelRevertFailed = true;
      }
    }

    fixes.push(fix);
  }

  return fixes;
}
