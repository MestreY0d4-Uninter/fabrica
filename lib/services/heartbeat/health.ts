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
 *   - A session is only considered alive if its registry entry still points at a
 *     readable session file; missing files are treated as dead evidence.
 *   - Grace period: workers activated within the last GRACE_PERIOD_MS are never
 *     considered session-dead (they may not appear in sessions yet).
 *   - abortedLastRun: indicates session hit context limit (#287, #290) — triggers immediate healing.
 */
import type { StateLabel, IssueProvider, Issue, PrStatus } from "../../providers/provider.js";
import type { RunCommand } from "../../context.js";
import { PrState } from "../../providers/provider.js";
import {
  getRoleWorker,
  readProjects,
  getProject,
  getIssueRuntime,
  getCanonicalPrSelector,
  updateSlot,
  updateIssueRuntime,
  deactivateWorker,
  type Project,
} from "../../projects/index.js";
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
import {
  getLastObservableSessionActivityAt,
  hasObservableSessionActivitySince,
  isSessionAlive,
  isTerminalSession,
  type SessionLookup,
} from "../gateway-sessions.js";
import { recordIssueLifecycle } from "../../projects/lifecycle.js";
import { withCorrelationContext } from "../../observability/context.js";
import { withTelemetrySpan } from "../../observability/telemetry.js";
import { resilientLabelTransition } from "../../workflow/labels.js";
import { notify, type NotificationConfig } from "../../dispatch/notify.js";
import { decidePostPrConvergence } from "../post-pr-convergence.js";
import {
  applyWorkerResult,
  readWorkerResultFromSessionFile,
  resolveWorkerSessionContext,
} from "../worker-completion.js";

// Re-export for consumers that import from health.ts
export { fetchGatewaySessions, isSessionAlive, type GatewaySession, type SessionLookup } from "../gateway-sessions.js";

/** Grace period: skip session-dead checks for workers started within this window.
 * Now configurable via resolvedConfig.timeouts.healthGracePeriodMs — fallback default preserved for callers without config. */
export const GRACE_PERIOD_MS = 5 * 60 * 1_000; // 5 minutes (enough for dispatch + LLM bootstrap; was 15 min which masked dead subagents)

/** Dispatch confirm timeout: flag dispatches that were never acknowledged by the worker.
 * Now configurable via resolvedConfig.timeouts.dispatchConfirmTimeoutMs — fallback default preserved for callers without config. */
export const DISPATCH_CONFIRMATION_TIMEOUT_MS = 2 * 60 * 1_000; // 2 minutes
export const COMPLETION_RECOVERY_WINDOW_MS = 2 * 60 * 1_000; // 2 minutes
export const EXECUTION_CONTRACT_RECOVERY_WINDOW_MS = 60 * 1_000; // 1 minute


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
    | "dispatch_unconfirmed" // Active worker never reached agent bootstrap/activity after dispatch
    | "completion_recovery_exhausted" // Worker showed activity but never produced a canonical result
    | "execution_contract_recovery_exhausted" // Worker violated execution contract and did not recover canonically
    | "stalled_with_artifact" // Active worker has a reviewable PR but stopped converging toward completion
    | "terminal_completion_repair" // Terminal session transcript proved completion and heartbeat repaired it
    | "stateless_issue";     // Case 8: open managed issue with no state label (#473)
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
    }).catch(() => {});
  }));
}

function hasDispatchCycleMismatch(
  slot: { dispatchCycleId?: string | null },
  issueRuntime?: { lastDispatchCycleId?: string | null } | null,
): boolean {
  return Boolean(
    slot.dispatchCycleId &&
    issueRuntime?.lastDispatchCycleId &&
    slot.dispatchCycleId !== issueRuntime.lastDispatchCycleId,
  );
}

function hasDispatchRunMismatch(
  slot: { dispatchRunId?: string | null },
  issueRuntime?: { dispatchRunId?: string | null } | null,
): boolean {
  return Boolean(
    slot.dispatchRunId &&
    issueRuntime?.dispatchRunId &&
    slot.dispatchRunId !== issueRuntime.dispatchRunId,
  );
}

function getTerminalSessionEvidenceAt(session: {
  endedAt?: number | null;
  sessionFileMtime?: number | null;
  updatedAt?: number | null;
}): number | null {
  const timestamps = [session.endedAt ?? null, session.sessionFileMtime ?? null, session.updatedAt ?? null]
    .filter((value): value is number => value !== null && Number.isFinite(value) && value > 0);
  if (timestamps.length === 0) return null;
  return Math.max(...timestamps);
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
 * Repair stays inside queue semantics only. If PR feedback exists, prefer the
 * feedback queue ("To Improve"); otherwise fall back to the default queue.
 */
async function resolveOrphanRevertLabel(
  provider: IssueProvider,
  project: Project,
  issueId: number,
  role: Role,
  defaultQueueLabel: string,
  workflow: WorkflowConfig,
): Promise<string> {
  try {
    const prSelector = getCanonicalPrSelector(project, issueId);
    const prStatus = await provider.getPrStatus(issueId, prSelector);
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
  /** Configurable dispatch confirmation timeout in ms (default: DISPATCH_CONFIRMATION_TIMEOUT_MS) */
  dispatchConfirmTimeoutMs?: number;
  /** Configurable grace period in ms before a fresh worker is considered session-dead. */
  healthGracePeriodMs?: number;
  /** Configurable recovery window in ms for inconclusive completion before requeue. */
  completionRecoveryWindowMs?: number;
  /** Configurable short recovery window in ms for execution-contract violations before requeue. */
  executionContractRecoveryWindowMs?: number;
  /** Command runner used for timeline notifications when runtime is unavailable. */
  runCommand?: RunCommand;
  /** Emit a progress warning / recovery if a worker stays active too long without a reviewable artifact. */
  stallTimeoutMinutes?: number;
  /** Optional notification config for per-event suppression. */
  notificationConfig?: NotificationConfig;
}): Promise<HealthFix[]> {
  const {
    workspaceDir, projectSlug, project, role, autoFix, provider, sessions,
    workflow = DEFAULT_WORKFLOW,
    staleWorkerHours = 2,
    dispatchConfirmTimeoutMs = DISPATCH_CONFIRMATION_TIMEOUT_MS,
    healthGracePeriodMs = GRACE_PERIOD_MS,
    completionRecoveryWindowMs = COMPLETION_RECOVERY_WINDOW_MS,
    executionContractRecoveryWindowMs = EXECUTION_CONTRACT_RECOVERY_WINDOW_MS,
    runCommand,
    stallTimeoutMinutes = 25,
    notificationConfig,
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
      const session = sessionKey && sessions
        ? sessions.get(sessionKey)
        : undefined;

      // Use the label stored at dispatch time (previousLabel) if available
      const slotQueueLabel: string = slot.previousLabel ?? queueLabel;

      // Grace period: skip session liveness checks for recently-started workers
      const workerStartTime = slot.startTime ? new Date(slot.startTime).getTime() : null;
      const withinGracePeriod = workerStartTime !== null && (Date.now() - workerStartTime) < healthGracePeriodMs;
      const sessionAlive = slot.active && sessionKey && sessions
        ? isSessionAlive(sessionKey, sessions)
        : false;

      // Parse issueId
      const issueIdNum = slot.issueId ? Number(slot.issueId) : null;

      // Fetch issue state if we have an issueId
      let issue: Issue | null = null;
      let currentLabel: StateLabel | null = null;
      const issueRuntime = issueIdNum ? getIssueRuntime(project, issueIdNum) : undefined;
      const dispatchRequestedAt = issueRuntime?.dispatchRequestedAt ? Date.parse(issueRuntime.dispatchRequestedAt) : null;
      const agentAcceptedAt = issueRuntime?.agentAcceptedAt ? Date.parse(issueRuntime.agentAcceptedAt) : null;
      const activityBaselineMs = agentAcceptedAt ?? dispatchRequestedAt;
      const sessionActivityObserved = Boolean(
        slot.active &&
        sessionKey &&
        hasObservableSessionActivitySince(sessionKey, sessions, activityBaselineMs),
      );
      if (sessionActivityObserved && issueIdNum && !issueRuntime?.firstWorkerActivityAt) {
        await recordIssueLifecycle({
          workspaceDir,
          slug: projectSlug,
          issueId: issueIdNum,
          stage: "first_worker_activity",
          sessionKey,
          details: {
            source: "heartbeat_session_activity",
            role,
            level,
            slotIndex,
          },
        }).catch(() => {});
      }
      const dispatchActivityObserved = Boolean(
        issueRuntime?.firstWorkerActivityAt ||
        issueRuntime?.inconclusiveCompletionAt ||
        sessionActivityObserved,
      );
      const deliveryState = dispatchActivityObserved ? "activity_seen" : "unknown";
      const dispatchConfirmed = dispatchActivityObserved;
      const acceptedWithoutActivityTooLong =
        agentAcceptedAt !== null &&
        !dispatchConfirmed &&
        (Date.now() - agentAcceptedAt) > dispatchConfirmTimeoutMs;
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

      if (slot.active && hasDispatchCycleMismatch(slot, issueRuntime)) {
        await auditLog(workspaceDir, "health_fix_rejected", {
          type: "dispatch_cycle_mismatch",
          reason: "stale_dispatch_cycle",
          project: project.name,
          projectSlug,
          role,
          level,
          slotIndex,
          issueId: slot.issueId ?? null,
          sessionKey,
          slotDispatchCycleId: slot.dispatchCycleId ?? null,
          runtimeDispatchCycleId: issueRuntime?.lastDispatchCycleId ?? null,
        }).catch(() => {});
        continue;
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

      const terminalRepairRole = role === "developer" || role === "tester" || role === "architect"
        ? role
        : null;
      if (
        terminalRepairRole &&
        slot.active &&
        issue &&
        currentLabel === expectedLabel &&
        issueIdNum &&
        sessionKey &&
        session &&
        isTerminalSession(session) &&
        issueRuntime?.sessionCompletedAt == null &&
        issueRuntime?.lastSessionKey === sessionKey &&
        !hasDispatchRunMismatch(slot, issueRuntime)
      ) {
        const terminalEvidenceAt = getTerminalSessionEvidenceAt(session);
        const dispatchBaselineAt = agentAcceptedAt ?? dispatchRequestedAt;
        if (
          terminalEvidenceAt === null ||
          (dispatchBaselineAt !== null && terminalEvidenceAt < dispatchBaselineAt)
        ) {
          continue;
        }

        const context = await resolveWorkerSessionContext(sessionKey, workspaceDir);
        const transcriptResult = await readWorkerResultFromSessionFile(terminalRepairRole, session.sessionFile);

        if (context && transcriptResult) {
          const fix: HealthFix = {
            issue: {
              type: "terminal_completion_repair",
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
              message: `${role.toUpperCase()} ${level}[${slotIndex}] terminal session "${sessionKey}" contained a canonical completion result and can be recovered`,
            },
            fixed: false,
          };

          if (!autoFix) {
            fixes.push(fix);
            continue;
          }

          if (runCommand) {
            const completion = await applyWorkerResult({
              context,
              result: transcriptResult,
              workspaceDir,
              runCommand,
              providerOverride: provider,
            });

            if (completion.applied) {
              fix.fixed = true;
              const toLabel = getCompletionRule(workflow, role, transcriptResult.value.toLowerCase())?.to ?? null;
              await auditHealthFixApplied(workspaceDir, fix, {
                action: "recover_terminal_completion",
                fromLabel: expectedLabel,
                toLabel,
                deliveryState,
              });
              fixes.push(fix);
              continue;
            }

            if (completion.reason === "already_completed" || completion.reason === "stale_dispatch_cycle") {
              continue;
            }
          }
        }
      }

      if (slot.active && issue && currentLabel === expectedLabel && issueRuntime?.inconclusiveCompletionAt) {
        const inconclusiveAt = Date.parse(issueRuntime.inconclusiveCompletionAt);
        const inconclusiveReason = issueRuntime.inconclusiveCompletionReason ?? "missing_result_line";
        const executionContractRecovery = inconclusiveReason === "invalid_execution_path";
        const recoveryWindowMs = executionContractRecovery
          ? executionContractRecoveryWindowMs
          : completionRecoveryWindowMs;
        const lastObservableAt = sessionKey
          ? getLastObservableSessionActivityAt(sessionKey, sessions)
          : null;
        const stillProgressing = lastObservableAt !== null && lastObservableAt > inconclusiveAt;
        const recoveryExpired = Number.isFinite(inconclusiveAt) && (Date.now() - inconclusiveAt) > recoveryWindowMs;

        if (stillProgressing || !recoveryExpired) {
          continue;
        }

        if (executionContractRecovery) {
          await auditLog(workspaceDir, "worker_execution_recovery_exhausted", {
            project: project.name,
            projectSlug,
            role,
            level,
            sessionKey,
            issueId: slot.issueId,
            slotIndex,
            reason: inconclusiveReason,
            recoveryWindowMs,
            dispatchCycleId: slot.dispatchCycleId ?? issueRuntime?.lastDispatchCycleId ?? null,
            dispatchRunId: slot.dispatchRunId ?? issueRuntime?.dispatchRunId ?? null,
          }).catch(() => {});
        }

        const convergence = decidePostPrConvergence({
          workflow,
          issueRuntime,
          reason: inconclusiveReason,
          feedbackQueueLabel: slotQueueLabel,
        });
        const fix: HealthFix = {
          issue: {
            type: executionContractRecovery
              ? "execution_contract_recovery_exhausted"
              : "completion_recovery_exhausted",
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
            message: executionContractRecovery
              ? `${role.toUpperCase()} ${level}[${slotIndex}] execution-contract recovery exhausted without canonical result`
              : `${role.toUpperCase()} ${level}[${slotIndex}] completion recovery exhausted after observable activity without canonical result`,
          },
          fixed: false,
        };

        if (autoFix) {
          const channel = project.channels?.[0];
          await notify(
            {
              type: "workerRecoveryExhausted",
              project: project.name,
              issueId: issueIdNum!,
              issueUrl: issue.web_url,
              issueTitle: issue.title,
              role,
              detail: convergence.action === "escalate_human"
                ? `Repeated post-PR recovery cause ${convergence.cause} exceeded retry budget (${convergence.retryCount}/${convergence.maxRetries}). Escalating for human decision.`
                : (executionContractRecovery
                  ? "Execution contract violation did not recover with a canonical completion result"
                  : "No canonical completion result was produced after observable activity"),
              nextState: convergence.targetLabel,
              dispatchCycleId: slot.dispatchCycleId ?? issueRuntime?.lastDispatchCycleId ?? null,
              dispatchRunId: slot.dispatchRunId ?? issueRuntime?.dispatchRunId ?? null,
            },
            {
              workspaceDir,
              config: notificationConfig,
              target: channel
                ? {
                    channelId: channel.channelId,
                    channel: channel.channel,
                    accountId: channel.accountId,
                    messageThreadId: channel.messageThreadId,
                  }
                : undefined,
              runCommand,
            },
          ).catch(() => {});
          await revertLabel(fix, expectedLabel, convergence.targetLabel);
          if (!fix.labelRevertFailed) {
            await deactivateSlot();
            await updateIssueRuntime(workspaceDir, projectSlug, issueIdNum!, {
              inconclusiveCompletionAt: null,
              inconclusiveCompletionReason: null,
              lastConvergenceCause: convergence.cause,
              lastConvergenceAction: convergence.action,
              lastConvergenceRetryCount: convergence.retryCount,
              lastConvergenceReason: inconclusiveReason,
              lastConvergenceAt: new Date().toISOString(),
            }).catch(() => {});
            fix.fixed = true;
            if (executionContractRecovery) {
              await auditLog(workspaceDir, "worker_execution_requeued", {
                project: project.name,
                projectSlug,
                role,
                level,
                sessionKey,
                issueId: slot.issueId,
                slotIndex,
                reason: inconclusiveReason,
                fromLabel: expectedLabel,
                toLabel: convergence.targetLabel,
                dispatchCycleId: slot.dispatchCycleId ?? issueRuntime?.lastDispatchCycleId ?? null,
                dispatchRunId: slot.dispatchRunId ?? issueRuntime?.dispatchRunId ?? null,
              }).catch(() => {});
            }
            await auditHealthFixApplied(workspaceDir, fix, {
              action: convergence.action === "escalate_human" ? "escalate_human" : "requeue_issue",
              fromLabel: expectedLabel,
              toLabel: convergence.targetLabel,
              deliveryState,
            });
          }
        }

        fixes.push(fix);
        continue;
      }

      // Case 1: Active with correct label but session is dead/missing
      if (slot.active && sessionKey && sessions && !withinGracePeriod && !sessionAlive) {
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
      if (slot.active && sessionKey && sessions && sessionAlive) {
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
      if (slot.active && sessionKey && sessions && sessionAlive) {
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
        (dispatchRequestedAt !== null || agentAcceptedAt !== null) &&
        !dispatchConfirmed &&
        (
          (dispatchRequestedAt !== null && (Date.now() - dispatchRequestedAt) > dispatchConfirmTimeoutMs) ||
          acceptedWithoutActivityTooLong
        )
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

      // Case 3: Active with correct label and alive session — warn/recover if a developer keeps working
      // for too long without a reviewable artifact, then fall back to the coarse stale-worker safety net.
      if (slot.active && slot.startTime && sessionKey && sessions && sessionAlive) {
        const startedAtMs = new Date(slot.startTime).getTime();
        const minutesActive = (Date.now() - startedAtMs) / 60_000;
        const hours = minutesActive / 60;
        let reviewablePrStatus: PrStatus | null = null;
        let hasReviewableArtifact = Boolean(
          issueRuntime?.currentPrNumber ||
          issueRuntime?.currentPrUrl ||
          issueRuntime?.artifactOfRecord?.prNumber,
        );
        if (issueIdNum) {
          try {
            const prStatus = await provider.getPrStatus(issueIdNum);
            if (
              prStatus.url &&
              prStatus.state !== PrState.MERGED &&
              prStatus.state !== PrState.CLOSED &&
              prStatus.currentIssueMatch !== false
            ) {
              reviewablePrStatus = prStatus;
              hasReviewableArtifact = true;
            }
          } catch {
            // Best-effort only — fall back to cached runtime state if provider lookup fails.
          }
        }

        if (
          role === "developer" &&
          issue &&
          issueIdNum &&
          !hasReviewableArtifact &&
          minutesActive >= Math.max(5, Math.floor(stallTimeoutMinutes / 2)) &&
          !issueRuntime?.progressNotifiedAt
        ) {
          const channel = project.channels?.[0];
          await notify(
            {
              type: "workerProgress",
              project: project.name,
              issueId: issueIdNum,
              issueUrl: issue.web_url,
              issueTitle: issue.title,
              role,
              level,
              minutesActive: Math.round(minutesActive),
              summary: "Still iterating on implementation/QA without a PR yet.",
              dispatchCycleId: slot.dispatchCycleId ?? issueRuntime?.lastDispatchCycleId ?? null,
              dispatchRunId: slot.dispatchRunId ?? issueRuntime?.dispatchRunId ?? null,
            },
            {
              workspaceDir,
              config: notificationConfig,
              target: channel
                ? {
                    channelId: channel.channelId,
                    channel: channel.channel,
                    accountId: channel.accountId,
                    messageThreadId: channel.messageThreadId,
                  }
                : undefined,
              runCommand,
            },
          ).catch(() => {});
          await updateIssueRuntime(workspaceDir, projectSlug, issueIdNum, {
            progressNotifiedAt: new Date().toISOString(),
            lastSessionKey: sessionKey,
          }).catch(() => {});
        }

        if (
          role === "developer" &&
          issue &&
          issueIdNum &&
          !hasReviewableArtifact &&
          minutesActive >= stallTimeoutMinutes
        ) {
          const fix: HealthFix = {
            issue: {
              type: "completion_recovery_exhausted",
              severity: "critical",
              project: project.name,
              projectSlug,
              role,
              level,
              sessionKey,
              issueId: slot.issueId,
              slotIndex,
              message: `${role.toUpperCase()} ${level}[${slotIndex}] active for ${Math.round(minutesActive)}m without a PR or terminal result`,
            },
            fixed: false,
          };
          if (autoFix) {
            const channel = project.channels?.[0];
            await notify(
              {
                type: "workerRecoveryExhausted",
                project: project.name,
                issueId: issueIdNum,
                issueUrl: issue.web_url,
                issueTitle: issue.title,
                role,
                detail: `No PR or canonical completion after ${Math.round(minutesActive)} minutes of active work. Re-queueing for a fresh attempt.`,
                nextState: slotQueueLabel,
                dispatchCycleId: slot.dispatchCycleId ?? issueRuntime?.lastDispatchCycleId ?? null,
                dispatchRunId: slot.dispatchRunId ?? issueRuntime?.dispatchRunId ?? null,
              },
              {
                workspaceDir,
                config: notificationConfig,
                target: channel
                  ? {
                      channelId: channel.channelId,
                      channel: channel.channel,
                      accountId: channel.accountId,
                      messageThreadId: channel.messageThreadId,
                    }
                  : undefined,
                runCommand,
              },
            ).catch(() => {});
            await revertLabel(fix, expectedLabel, slotQueueLabel);
            if (!fix.labelRevertFailed) {
              await deactivateSlot();
              await updateIssueRuntime(workspaceDir, projectSlug, issueIdNum, {
                inconclusiveCompletionAt: new Date().toISOString(),
                inconclusiveCompletionReason: "stalled_without_artifact",
                progressNotifiedAt: null,
              }).catch(() => {});
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

        const quietMinutes = (() => {
          const lastObservableAt = sessionKey
            ? getLastObservableSessionActivityAt(sessionKey, sessions)
            : null;
          const referenceAt = lastObservableAt ?? agentAcceptedAt ?? dispatchRequestedAt ?? startedAtMs;
          if (!referenceAt || Number.isNaN(referenceAt)) return minutesActive;
          return (Date.now() - referenceAt) / 60_000;
        })();

        if (
          role === "developer" &&
          issue &&
          issueIdNum &&
          hasReviewableArtifact &&
          reviewablePrStatus?.url &&
          minutesActive >= stallTimeoutMinutes &&
          quietMinutes >= Math.max(8, Math.floor(stallTimeoutMinutes / 2))
        ) {
          const convergence = decidePostPrConvergence({
            workflow,
            issueRuntime,
            reason: "stalled_with_artifact",
            feedbackQueueLabel: slotQueueLabel,
          });
          const fix: HealthFix = {
            issue: {
              type: "stalled_with_artifact",
              severity: "critical",
              project: project.name,
              projectSlug,
              role,
              level,
              sessionKey,
              issueId: slot.issueId,
              slotIndex,
              message: `${role.toUpperCase()} ${level}[${slotIndex}] has an open PR but stayed idle for ${Math.round(quietMinutes)}m without converging`,
            },
            fixed: false,
          };
          if (autoFix) {
            const channel = project.channels?.[0];
            await notify(
              {
                type: "workerRecoveryExhausted",
                project: project.name,
                issueId: issueIdNum,
                issueUrl: issue.web_url,
                issueTitle: issue.title,
                role,
                detail: convergence.action === "escalate_human"
                  ? `Open PR ${reviewablePrStatus.url} exceeded the retry budget for ${convergence.cause} (${convergence.retryCount}/${convergence.maxRetries}). Escalating for human decision.`
                  : `Open PR ${reviewablePrStatus.url} has stalled for ${Math.round(quietMinutes)} minutes without a trustworthy completion. Re-queueing to ${slotQueueLabel}.`,
                nextState: convergence.targetLabel,
                dispatchCycleId: slot.dispatchCycleId ?? issueRuntime?.lastDispatchCycleId ?? null,
                dispatchRunId: slot.dispatchRunId ?? issueRuntime?.dispatchRunId ?? null,
              },
              {
                workspaceDir,
                config: notificationConfig,
                target: channel
                  ? {
                      channelId: channel.channelId,
                      channel: channel.channel,
                      accountId: channel.accountId,
                      messageThreadId: channel.messageThreadId,
                    }
                  : undefined,
                runCommand,
              },
            ).catch(() => {});
            await revertLabel(fix, expectedLabel, convergence.targetLabel);
            if (!fix.labelRevertFailed) {
              await deactivateSlot();
              await updateIssueRuntime(workspaceDir, projectSlug, issueIdNum, {
                inconclusiveCompletionAt: new Date().toISOString(),
                inconclusiveCompletionReason: "stalled_with_artifact",
                progressNotifiedAt: null,
                lastConvergenceCause: convergence.cause,
                lastConvergenceAction: convergence.action,
                lastConvergenceRetryCount: convergence.retryCount,
                lastConvergenceReason: "stalled_with_artifact",
                lastConvergenceAt: new Date().toISOString(),
              }).catch(() => {});
              fix.fixed = true;
              await auditHealthFixApplied(workspaceDir, fix, {
                action: convergence.action === "escalate_human" ? "escalate_human" : "requeue_issue",
                fromLabel: expectedLabel,
                toLabel: convergence.targetLabel,
                idleMinutes: Math.round(quietMinutes),
                deliveryState,
              });
            }
          }
          fixes.push(fix);
          continue;
        }

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
            provider, freshProject, issue.iid, role, queueLabel, workflow,
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
