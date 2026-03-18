/**
 * dispatch/index.ts — Core dispatch logic used by projectTick (heartbeat).
 *
 * Handles: session lookup, spawn/reuse via Gateway RPC, task dispatch via CLI,
 * state update (activateWorker), and audit logging.
 */
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { RunCommand } from "../context.js";
import { log as auditLog } from "../audit.js";
import { PrState, type PrSelector } from "../providers/provider.js";
import {
  type Project,
  activateWorker,
  updateSlot,
  getRoleWorker,
  getIssueRuntime,
  requireCanonicalPrSelector,
  emptySlot,
  recordIssueLifecycle,
} from "../projects/index.js";
import { resolveModel } from "../roles/index.js";
import { notify, getNotificationConfig } from "./notify.js";
import { loadConfig, type ResolvedRoleConfig } from "../config/index.js";
import type { WorkflowResolutionMeta } from "../config/workflow-policy.js";
import { ReviewPolicy, TestPolicy, resolveReviewRouting, resolveTestRouting, resolveNotifyChannel, isFeedbackState, hasReviewCheck, producesReviewableWork, hasTestPhase, detectOwner, getOwnerLabel, OWNER_LABEL_COLOR, getRoleLabelColor, STEP_ROUTING_COLOR, getStateLabels, resilientLabelTransition } from "../workflow/index.js";
import { fetchPrFeedback, fetchPrContext, type PrFeedback, type PrContext } from "./pr-context.js";
import { formatAttachmentsForTask } from "./attachments.js";
import { loadRoleInstructions } from "./bootstrap-hook.js";
import { slotName } from "../names.js";
import { selectIssueComments } from "./issue-comments.js";
import { loadSecurityChecklist } from "./security-checklist.js";
import { resolveEffectiveModelForGateway } from "../roles/model-fetcher.js";

import { buildTaskMessage, buildConflictFixMessage, buildAnnouncement, formatSessionLabel, formatSessionLabelFull } from "./message-builder.js";
import { ensureSessionReady, sendToAgent, shouldClearSession } from "./session.js";
import { acknowledgeComments, EYES_EMOJI } from "./acknowledge.js";

export type DispatchOpts = {
  workspaceDir: string;
  agentId?: string;
  project: Project;
  issueId: number;
  issueTitle: string;
  issueDescription: string;
  issueUrl: string;
  role: string;
  /** Developer level (junior, mid, senior) or raw model ID */
  level: string;
  /** Label to transition FROM (e.g. "To Do", "To Test", "To Improve") */
  fromLabel: string;
  /** Label to transition TO (e.g. "Doing", "Testing") */
  toLabel: string;
  /** Issue provider for issue operations and label transitions */
  provider: import("../providers/provider.js").IssueProvider;
  /** Plugin config for model resolution and notification config */
  pluginConfig?: Record<string, unknown>;
  /** Orchestrator's session key (used as spawnedBy for subagent tracking) */
  sessionKey?: string;
  /** Plugin runtime for direct API access (avoids CLI subprocess timeouts) */
  runtime?: PluginRuntime;
  /** Slot index within the role's worker slots (defaults to 0 for single-worker compat) */
  slotIndex?: number;
  /** Instance name for ownership labels (auto-claimed on dispatch if not already owned) */
  instanceName?: string;
  /** Injected runCommand for dependency injection. */
  runCommand: RunCommand;
};

export type DispatchResult = {
  sessionAction: "spawn" | "send";
  sessionKey: string;
  level: string;
  model: string;
  announcement: string;
};

/**
 * Dispatch a task to a worker session.
 *
 * Flow:
 *   1. Resolve model, session key, build task message (setup — no side effects)
 *   2. Transition label (commitment point — issue leaves queue)
 *   3. Apply labels, send notification
 *   4. Ensure session (fire-and-forget) + send to agent
 *   5. Update worker state
 *   6. Audit
 *
 * If setup fails, the issue stays in its queue untouched.
 * On state update failure after dispatch: logs warning (session IS running).
 */
export async function dispatchTask(
  opts: DispatchOpts,
): Promise<DispatchResult> {
  const {
    workspaceDir, agentId, project, issueId, issueTitle,
    issueDescription, issueUrl, role, level, fromLabel, toLabel,
    provider, pluginConfig, runtime,
  } = opts;

  const slotIndex = opts.slotIndex ?? 0;
  const rc = opts.runCommand;

  // ── Setup (no side effects — safe to fail) ──────────────────────────
  const resolvedConfig = await loadConfig(workspaceDir, project.slug);
  const resolvedRole = resolvedConfig.roles[role];
  const { timeouts } = resolvedConfig;
  const resolvedModel = resolveModel(role, level, resolvedRole);
  const effectiveModel = await resolveEffectiveModelForGateway(resolvedModel, rc);
  const model = effectiveModel.effective;
  const roleWorker = getRoleWorker(project, role);
  const slot = roleWorker.levels[level]?.[slotIndex] ?? emptySlot();
  let existingSessionKey = slot.sessionKey;
  const issueRuntime = getIssueRuntime(project, issueId);
  const prSelector: PrSelector | undefined = (role === "reviewer" || role === "tester")
    ? requireCanonicalPrSelector(project, issueId, `dispatch ${role}`)
    : (issueRuntime?.currentPrNumber ? { prNumber: issueRuntime.currentPrNumber } : undefined);

  if (role === "reviewer" || role === "tester") {
    const prStatus = await provider.getPrStatus(issueId, prSelector);
    const hasReviewablePr = !!prStatus.url &&
      prStatus.state !== PrState.MERGED &&
      prStatus.state !== PrState.CLOSED &&
      prStatus.currentIssueMatch !== false;
    if (!hasReviewablePr) {
      throw new Error(`Cannot dispatch ${role} without an open PR for issue #${issueId}`);
    }
  }

  // Deactivated slot: preserve session if same issue is returning (feedback cycle)
  if (existingSessionKey && !slot.issueId) {
    const isSameIssueReturn = slot.lastIssueId && String(issueId) === String(slot.lastIssueId);
    if (!isSameIssueReturn) {
      await rc(
        ["openclaw", "gateway", "call", "sessions.delete", "--params", JSON.stringify({ key: existingSessionKey })],
        { timeoutMs: 10_000 },
      ).catch((err: Error) => console.error("[fabrica] silent-catch:", err.message));
      existingSessionKey = null;
    }
  }

  // Feedback-cycle guard: when a developer issue returns from a feedback queue
  // (for example `To Improve` after TESTER FAIL), force a fresh session even for
  // the same issue. Reusing the old session tends to preserve the prior
  // “already done” mindset and can create a no-op loop where the developer keeps
  // sending `work_finish(done)` without addressing the new feedback.
  if (existingSessionKey && role === "developer" && isFeedbackState(project.workflow, fromLabel)) {
    await rc(
      ["openclaw", "gateway", "call", "sessions.delete", "--params", JSON.stringify({ key: existingSessionKey })],
      { timeoutMs: 10_000 },
    ).catch((err: Error) => console.error("[fabrica] silent-catch:", err.message));
    await updateSlot(workspaceDir, project.slug, role, level, slotIndex, {
      sessionKey: null,
    });
    await auditLog(workspaceDir, "session_feedback_reset", {
      project: project.name,
      projectSlug: project.slug,
      issue: issueId,
      role,
      level,
      fromLabel,
      sessionKey: existingSessionKey,
      reason: "developer_feedback_cycle_requires_fresh_context",
    }).catch(() => {});
    existingSessionKey = null;
  }

  // Context budget check: clear session if over budget (unless same issue — feedback cycle)
  if (existingSessionKey && timeouts.sessionContextBudget < 1) {
    const shouldClear = await shouldClearSession(existingSessionKey, slot.issueId, issueId, timeouts, workspaceDir, project.name, rc);
    if (shouldClear) {
      // Delete the gateway session (await to prevent race with later sessions.patch)
      await rc(
        ["openclaw", "gateway", "call", "sessions.delete", "--params", JSON.stringify({ key: existingSessionKey })],
        { timeoutMs: 10_000 },
      ).catch((err: Error) => console.error("[fabrica] silent-catch:", err.message));
      await updateSlot(workspaceDir, project.slug, role, level, slotIndex, {
        sessionKey: null,
      });
      existingSessionKey = null;
    }
  }

  // Compute session key deterministically (avoids waiting for gateway)
  // Slot name provides both collision prevention and human-readable identity
  const botName = slotName(project.name, role, level, slotIndex);
  const sessionKey = `agent:${agentId ?? "unknown"}:subagent:${project.name}-${role}-${level}-${botName.toLowerCase()}`;

  // Clear stale session key if it doesn't match the current deterministic key
  // (handles migration from old numeric format like ...-0 to name-based ...-Cordelia)
  // Guard: only migrate if the existing key is for the same role (prevents cross-role collision)
  if (existingSessionKey && existingSessionKey !== sessionKey) {
    const existingKeyIsForSameRole = existingSessionKey.includes(`:${project.name}-${role}-`);
    if (existingKeyIsForSameRole) {
      // Delete the orphaned gateway session (await to prevent race with later sessions.patch)
      await rc(
        ["openclaw", "gateway", "call", "sessions.delete", "--params", JSON.stringify({ key: existingSessionKey })],
        { timeoutMs: 10_000 },
      ).catch((err: Error) => console.error("[fabrica] silent-catch:", err.message));
      existingSessionKey = null;
    }
  }

  const sessionAction = existingSessionKey ? "send" : "spawn";

  // Fetch issue discussion (filtered later based on role/phase)
  const allComments = await provider.listComments(issueId);

  // Fetch PR context based on workflow role semantics (no hardcoded role/label checks)
  const { workflow } = resolvedConfig;
  const prFeedback = isFeedbackState(workflow, fromLabel)
    ? await fetchPrFeedback(provider, issueId, prSelector) : undefined;
  const prContext = hasReviewCheck(workflow, role)
    ? await fetchPrContext(provider, issueId, prSelector) : undefined;
  const comments = selectIssueComments(allComments, {
    role,
    hasPrContext: !!prContext,
    hasPrFeedback: !!prFeedback,
  });

  // Fetch attachment context (best-effort — never blocks dispatch)
  let attachmentContext: string | undefined;
  try {
    attachmentContext = await formatAttachmentsForTask(workspaceDir, project.slug, issueId) || undefined;
  } catch { /* best-effort */ }
  const securityChecklist = await loadSecurityChecklist(workspaceDir, project.name).catch(() => "");

  // Native fix for Patch 1: use slug as primary identifier (not channelId)
  const primaryChannelId = project.slug;
  const isConflictFix = prFeedback?.reason === "merge_conflict";
  const repoContext = project.repoRemote?.replace(/\.git$/, "") ?? project.slug;
  const taskMessage = isConflictFix && prFeedback
    ? buildConflictFixMessage({
        projectName: project.name, channelId: primaryChannelId, role, issueId,
        issueTitle, issueUrl,
        repo: repoContext, baseBranch: project.baseBranch,
        resolvedRole, prFeedback,
      })
    : buildTaskMessage({
        projectName: project.name, channelId: primaryChannelId, role, issueId,
        issueTitle, issueDescription, issueUrl,
        repo: repoContext, baseBranch: project.baseBranch,
        comments,
        resolvedRole,
        prContext,
        prFeedback,
        securityChecklist,
        attachmentContext,
        followUpPrRequired: issueRuntime?.followUpPrRequired === true,
      });

  // Load role-specific instructions to inject into the worker's system prompt
  const roleInstructions = await loadRoleInstructions(workspaceDir, project.name, role);

  // ── Pre-commitment: ensure session exists before transitioning label ─
  // If session setup fails here, the issue stays in its queue state and the
  // heartbeat can retry on the next tick. Moving this before transitionLabel
  // prevents the "Doing with no worker" stuck state (C2).
  const sessionLabel = formatSessionLabel(project.name, role, level, botName);
  const sessionLabelFull = formatSessionLabelFull(project.name, role, level, botName);
  await ensureSessionReady(
    sessionKey,
    model,
    workspaceDir,
    rc,
    timeouts.sessionPatchMs,
    sessionLabel,
    { slug: project.slug, issueId },
  );

  // ── Commitment point — transition label (issue leaves queue) ────────
  const labelResult = await resilientLabelTransition(provider, issueId, fromLabel, toLabel,
    (msg) => auditLog(workspaceDir, "dispatch_warning", { step: "label_transition", issue: issueId, msg }).catch(() => {}),
  );
  if (!labelResult.success) {
    throw new Error(`Label transition failed: ${fromLabel} → ${toLabel} for issue #${issueId}`);
  }
  if (labelResult.dualStateResolved) {
    auditLog(workspaceDir, "dispatch_warning", { step: "label_transition", issue: issueId, msg: "dual_state_resolved" }).catch(() => {});
  }

  // Mark issue + PR as managed and all consumed comments as seen (fire-and-forget)
  provider.reactToIssue(issueId, EYES_EMOJI).catch((err: Error) => console.error("[fabrica] silent-catch:", err.message));
  provider.reactToPr(issueId, EYES_EMOJI).catch((err: Error) => console.error("[fabrica] silent-catch:", err.message));
  acknowledgeComments(provider, issueId, allComments, prFeedback, workspaceDir).catch((err) => {
    auditLog(workspaceDir, "dispatch_warning", {
      step: "acknowledgeComments",
      issue: issueId,
      error: (err as Error).message ?? String(err),
    }).catch((auditErr: Error) => console.error("[fabrica] silent-catch:", auditErr.message));
  });

  // Apply role:level label (best-effort — failure must not abort dispatch)
  // IMPORTANT: Never pass state labels to removeLabels() — state transitions are
  // handled exclusively by transitionLabel(). Accidentally removing a state label
  // makes the issue invisible to the queue scanner. See #473 for context.
  let issue: { labels: string[] } | undefined;
  try {
    issue = await provider.getIssue(issueId);
    const stateLabels = getStateLabels(workflow);

    const oldRoleLabels = issue.labels.filter((l) => l.startsWith(`${role}:`));
    const safeRoleLabels = filterNonStateLabels(oldRoleLabels, stateLabels);
    if (safeRoleLabels.length > 0) {
      await provider.removeLabels(issueId, safeRoleLabels);
    }
    const roleLabel = `${role}:${level}:${botName}`;
    await provider.ensureLabel(roleLabel, getRoleLabelColor(role));
    await provider.addLabel(issueId, roleLabel);

    // Apply review routing label when role produces reviewable work (best-effort)
    if (producesReviewableWork(workflow, role)) {
      const reviewLabel = resolveReviewRouting(
        workflow.reviewPolicy ?? ReviewPolicy.HUMAN, level,
      );
      const oldRouting = issue.labels.filter((l) => l.startsWith("review:"));
      const safeRouting = filterNonStateLabels(oldRouting, stateLabels);
      if (safeRouting.length > 0) await provider.removeLabels(issueId, safeRouting);
      await provider.ensureLabel(reviewLabel, STEP_ROUTING_COLOR);
      await provider.addLabel(issueId, reviewLabel);
    }

    // Apply test routing label when workflow has a test phase (best-effort)
    if (hasTestPhase(workflow)) {
      const testLabel = resolveTestRouting(
        workflow.testPolicy ?? TestPolicy.SKIP, level,
      );
      const oldTestRouting = issue.labels.filter((l) => l.startsWith("test:"));
      const safeTestRouting = filterNonStateLabels(oldTestRouting, stateLabels);
      if (safeTestRouting.length > 0) await provider.removeLabels(issueId, safeTestRouting);
      await provider.ensureLabel(testLabel, STEP_ROUTING_COLOR);
      await provider.addLabel(issueId, testLabel);
    }

    // Apply owner label if issue is unclaimed (auto-claim on pickup)
    if (opts.instanceName && !detectOwner(issue.labels)) {
      const ownerLabel = getOwnerLabel(opts.instanceName);
      await provider.ensureLabel(ownerLabel, OWNER_LABEL_COLOR);
      await provider.addLabel(issueId, ownerLabel);
    }
  } catch {
    // Best-effort — label failure must not abort dispatch
  }

  // Step 2: Send notification early (before session dispatch which can timeout)
  // This ensures users see the notification even if gateway is slow
  const notifyConfig = getNotificationConfig(pluginConfig);
  const notifyTarget = resolveNotifyChannel(issue?.labels ?? [], project.channels);
  notify(
    {
      type: "workerStart",
      project: project.name,
      issueId,
      issueTitle,
      issueUrl,
      role,
      level,
      name: botName,
      sessionAction,
      modelDowngraded: effectiveModel.downgraded,
      originalModel: effectiveModel.downgraded ? resolvedModel : undefined,
      effectiveModel: effectiveModel.downgraded ? model : undefined,
    },
    {
      workspaceDir,
      config: notifyConfig,
      channelId: notifyTarget?.channelId,
      channel: notifyTarget?.channel ?? "telegram",
      runtime,
      accountId: notifyTarget?.accountId,
      messageThreadId: notifyTarget?.messageThreadId,
      runCommand: rc,
    },
  ).catch((err) => {
    auditLog(workspaceDir, "dispatch_warning", {
      step: "notify", issue: issueId, role,
      error: (err as Error).message ?? String(err),
    }).catch((auditErr: Error) => console.error("[fabrica] silent-catch:", auditErr.message));
  });

  // Step 3: Send task to agent (fire-and-forget — session already confirmed above)
  // Model is set on the session via sessions.patch (pre-commitment), not on the agent RPC —
  // the gateway's agent endpoint rejects unknown properties like 'model'.
  sendToAgent(sessionKey, taskMessage, {
    agentId, projectName: project.name, projectSlug: project.slug, issueId, role, level, slotIndex, fromLabel,
    orchestratorSessionKey: opts.sessionKey, workspaceDir,
    dispatchTimeoutMs: timeouts.dispatchMs,
    extraSystemPrompt: roleInstructions.trim() || undefined,
    runCommand: rc,
    runtime,
  });

  // Step 5: Update worker state
  try {
    await recordWorkerState(workspaceDir, project.slug, role, slotIndex, {
      issueId, level, sessionKey, sessionAction, fromLabel, name: botName,
    });
    await recordIssueLifecycle({
      workspaceDir,
      slug: project.slug,
      issueId,
      stage: "dispatch_requested",
      sessionKey,
      details: { role, level, slotIndex, sessionAction },
    });
  } catch (err) {
    // Session is already dispatched — log warning but don't fail
    await auditLog(workspaceDir, "dispatch", {
      project: project.name, issue: issueId, role,
      warning: "State update failed after successful dispatch",
      error: (err as Error).message, sessionKey,
    });
  }

  // Step 6: Audit
  await auditDispatch(workspaceDir, {
    project: project.name, issueId, issueTitle,
    role, level, requestedModel: resolvedModel, resolvedModel, effectiveModel: model,
    modelDowngraded: effectiveModel.downgraded, modelFallbackReason: effectiveModel.reason,
    modelAvailability: effectiveModel.availableModels,
    workflowMeta: resolvedConfig.workflowMeta,
    sessionAction, sessionKey,
    fromLabel, toLabel, sessionLabel, sessionLabelFull,
  });

  const announcement = buildAnnouncement(level, role, sessionAction, issueId, issueTitle, issueUrl, resolvedRole, botName);

  return { sessionAction, sessionKey, level, model, announcement };
}

async function recordWorkerState(
  workspaceDir: string, slug: string, role: string, slotIndex: number,
  opts: { issueId: number; level: string; sessionKey: string; sessionAction: "spawn" | "send"; fromLabel?: string; name?: string },
): Promise<void> {
  await activateWorker(workspaceDir, slug, role, {
    issueId: String(opts.issueId),
    level: opts.level,
    sessionKey: opts.sessionKey,
    startTime: new Date().toISOString(),
    previousLabel: opts.fromLabel,
    slotIndex,
    name: opts.name,
  });
}

/**
 * Filter out state labels from a label array to prevent accidental state loss.
 * State labels should only be modified via transitionLabel(). See #473.
 */
function filterNonStateLabels(labels: string[], stateLabels: string[]): string[] {
  if (stateLabels.length === 0) {
    throw new Error("getStateLabels returned empty array — workflow may be malformed. Refusing to remove labels to prevent state loss.");
  }
  return labels.filter((l) => !stateLabels.includes(l));
}

async function auditDispatch(
  workspaceDir: string,
  opts: {
    project: string; issueId: number; issueTitle: string;
    role: string; level: string;
    requestedModel: string;
    resolvedModel: string;
    effectiveModel: string;
    modelDowngraded: boolean;
    modelFallbackReason?: string;
    modelAvailability: string[];
    workflowMeta: WorkflowResolutionMeta;
    sessionAction: string;
    sessionKey: string; fromLabel: string; toLabel: string; sessionLabel: string; sessionLabelFull: string;
  },
): Promise<void> {
  await auditLog(workspaceDir, "dispatch", {
    project: opts.project,
    issue: opts.issueId, issueTitle: opts.issueTitle,
    role: opts.role, level: opts.level,
    sessionAction: opts.sessionAction, sessionKey: opts.sessionKey,
    sessionLabel: opts.sessionLabel,
    sessionLabelFull: opts.sessionLabelFull,
    labelTransition: `${opts.fromLabel} → ${opts.toLabel}`,
  });
  await auditLog(workspaceDir, "session_dispatch_requested", {
    project: opts.project,
    issue: opts.issueId,
    role: opts.role,
    level: opts.level,
    sessionAction: opts.sessionAction,
    sessionKey: opts.sessionKey,
    sessionLabel: opts.sessionLabel,
    sessionLabelFull: opts.sessionLabelFull,
  });
  await auditLog(workspaceDir, "model_requested", {
    project: opts.project,
    issue: opts.issueId,
    role: opts.role,
    level: opts.level,
    requested: opts.requestedModel,
    sessionKey: opts.sessionKey,
  });
  await auditLog(workspaceDir, "model_resolved", {
    project: opts.project,
    issue: opts.issueId,
    role: opts.role,
    level: opts.level,
    resolved: opts.resolvedModel,
    model: opts.resolvedModel,
    sessionKey: opts.sessionKey,
  });
  await auditLog(workspaceDir, "model_effective", {
    project: opts.project,
    issue: opts.issueId,
    role: opts.role,
    level: opts.level,
    effective: opts.effectiveModel,
    sessionKey: opts.sessionKey,
  });
  if (opts.modelDowngraded) {
    await auditLog(workspaceDir, "model_downgraded", {
      project: opts.project,
      issue: opts.issueId,
      role: opts.role,
      level: opts.level,
      requested: opts.requestedModel,
      resolved: opts.resolvedModel,
      effective: opts.effectiveModel,
      availableModels: opts.modelAvailability,
      reason: opts.modelFallbackReason ?? null,
      sessionKey: opts.sessionKey,
    });
  }
  await auditLog(workspaceDir, "model_selection", {
    issue: opts.issueId,
    role: opts.role,
    level: opts.level,
    model: opts.effectiveModel,
    sessionKey: opts.sessionKey,
  });
  await auditLog(workspaceDir, "workflow_resolution", {
    project: opts.project,
    issue: opts.issueId,
    role: opts.role,
    sourceLayers: opts.workflowMeta.sourceLayers,
    workflowHash: opts.workflowMeta.hash,
    normalizationFixes: opts.workflowMeta.normalizationFixes.map((fix) => ({
      stateKey: fix.stateKey,
      event: fix.event,
      removedActions: fix.removedActions,
      reason: fix.reason,
    })),
    keyTransitions: opts.workflowMeta.keyTransitions,
  });
}
