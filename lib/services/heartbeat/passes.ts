/**
 * Heartbeat passes — health, review, review-skip, and test-skip passes.
 */
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { RunCommand } from "../../context.js";
import { type Project } from "../../projects/index.js";
import {
  checkWorkerHealth,
  scanOrphanedLabels,
  scanStatelessIssues,
  checkProgress,
  type SessionLookup,
} from "./health.js";
import { reviewPass } from "./review.js";
import { reviewSkipPass } from "./review-skip.js";
import { testSkipPass } from "./test-skip.js";
import { holdEscapePass } from "./hold-escape.js";
import type { ResolvedConfig } from "../../config/types.js";
import { resolveNotifyChannel, getStateLabels } from "../../workflow/index.js";
import { notify, getNotificationConfig } from "../../dispatch/notify.js";
import { getPendingIntents, markDelivered } from "../../dispatch/notification-outbox.js";
import { log as auditLog } from "../../audit.js";
import {
  getActiveLabel,
  getRevertLabel,
} from "../../workflow/index.js";
import { resilientLabelTransition } from "../../workflow/labels.js";
import { deactivateWorker } from "../../projects/index.js";
import {
  handleReviewerAgentEnd,
  resolveReviewerDecisionTransition,
} from "../reviewer-completion.js";

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

/**
 * Detect and fix issues with more than one state label (A2 — incomplete label transition).
 *
 * When a two-phase label transition (add new → remove old) is interrupted by a crash,
 * the issue ends up with two state labels. The heartbeat cannot reliably dispatch or
 * process such issues. This guard removes the extra label, preferring the active/doing
 * label over any queue label to preserve the committed transition intent.
 *
 * Returns the number of issues fixed.
 */
async function fixDualStateLabels(
  workspaceDir: string,
  projectSlug: string,
  project: Project,
  provider: import("../../providers/provider.js").IssueProvider,
  resolvedConfig: ResolvedConfig,
): Promise<number> {
  const stateLabels = getStateLabels(resolvedConfig.workflow);
  if (stateLabels.length === 0) return 0;

  let fixed = 0;
  try {
    const issues = await provider.listIssues({ state: "open" });
    for (const issue of issues) {
      const issueStateLabels = issue.labels.filter((l) => stateLabels.includes(l));
      if (issueStateLabels.length <= 1) continue;

      // Determine which label to keep: prefer active-type states over queue states.
      // Active labels correspond to "doing" states; queue labels to "todo" states.
      // In case of ambiguity, keep the last label (most recently added per API ordering).
      const activeLabels = issueStateLabels.filter((l) => {
        const stateEntry = Object.values(resolvedConfig.workflow.states)
          .find((s) => s.label === l);
        return stateEntry?.type === "active";
      });
      const keepLabel = activeLabels[0] ?? issueStateLabels[issueStateLabels.length - 1];
      const toRemove = issueStateLabels.filter((l) => l !== keepLabel);

      try {
        await provider.removeLabels(issue.iid, toRemove);
        fixed++;
        await auditLog(workspaceDir, "dual_state_label_fixed", {
          project: projectSlug,
          issueId: issue.iid,
          keptLabel: keepLabel,
          removedLabels: toRemove,
        }).catch(() => {});
      } catch {
        await auditLog(workspaceDir, "dual_state_label_fix_failed", {
          project: projectSlug,
          issueId: issue.iid,
          stateLabels: issueStateLabels,
        }).catch(() => {});
      }
    }
  } catch {
    // Best-effort — failure here must not abort the health pass
  }
  return fixed;
}

/**
 * Run health checks and auto-fix for a project (dev + qa roles).
 */
export async function performHealthPass(
  workspaceDir: string,
  projectSlug: string,
  project: any,
  sessions: SessionLookup | null,
  provider: import("../../providers/provider.js").IssueProvider,
  staleWorkerHours?: number,
  instanceName?: string,
  runCommand?: RunCommand,
  stallTimeoutMinutes?: number,
  agentId?: string,
  resolvedConfig?: ResolvedConfig,
  runtime?: PluginRuntime,
): Promise<number> {
  let fixedCount = 0;

  // Reprocess any notifications pending > 2 minutes (crash recovery)
  try {
    const pendingIntents = await getPendingIntents(workspaceDir).catch(() => []);
    const staleThreshold = Date.now() - 2 * 60_000;
    const notifyConfig = getNotificationConfig(resolvedConfig as unknown as Record<string, unknown> | undefined);
    for (const intent of pendingIntents) {
      if (intent.ts < staleThreshold) {
        try {
          const eventType = typeof intent.data?.type === "string"
            ? intent.data.type
            : undefined;
          const notificationsEnabled = eventType
            ? notifyConfig[eventType as keyof typeof notifyConfig] !== false
            : true;
          const hasDeliveryTarget = Boolean(intent.deliveryTarget?.channelId);
          const sent = intent.deliveryTarget?.channelId
            ? await notify(intent.data as any, {
              workspaceDir,
              config: notifyConfig,
              runtime,
              runCommand,
              deliveryTargetOverride: intent.deliveryTarget,
              skipOutboxWrite: true,
            })
            : await notify(intent.data as any, {
              workspaceDir,
              config: notifyConfig,
              runtime,
              runCommand,
              skipOutboxWrite: true,
            });
          if (sent && hasDeliveryTarget && notificationsEnabled) {
            await markDelivered(workspaceDir, intent.key).catch(() => {});
          }
        } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort — must not abort health pass */ }

  for (const role of Object.keys(project.workers)) {
    // Check worker health (session liveness, label consistency, etc)
    const healthFixes = await checkWorkerHealth({
      workspaceDir,
      projectSlug,
      project,
      role,
      sessions,
      autoFix: true,
      provider,
      staleWorkerHours,
      workflow: resolvedConfig?.workflow,
      dispatchConfirmTimeoutMs: resolvedConfig?.timeouts?.dispatchConfirmTimeoutMs,
      healthGracePeriodMs: resolvedConfig?.timeouts?.healthGracePeriodMs,
    });
    fixedCount += healthFixes.filter((f) => f.fixed).length;

    // Scan for orphaned labels (active labels with no tracking worker)
    const orphanFixes = await scanOrphanedLabels({
      workspaceDir,
      projectSlug,
      project,
      role,
      autoFix: true,
      provider,
      instanceName,
      workflow: resolvedConfig?.workflow,
    });
    fixedCount += orphanFixes.filter((f) => f.fixed).length;
  }

  // Emit audit events for stalled/slow workers (best-effort)
  for (const [role, workerData] of Object.entries(project.workers ?? {})) {
    for (const slots of Object.values((workerData as any).levels ?? {})) {
      for (const slot of (slots as any[]).filter((s: any) => s.active && s.startedAt)) {
        const ageMs = Date.now() - new Date(slot.startedAt).getTime();
        const status = checkProgress({ lastCommitAgeMs: ageMs, sessionActive: true });
        if (status !== "healthy") {
          await auditLog(workspaceDir, "worker_progress", {
            project: projectSlug, role, status, ageMs,
          }).catch(() => {});
        }
      }
    }
  }

  // Scan for stateless issues (managed issues that lost their state label — #473)
  const statelessFixes = await scanStatelessIssues({
    workspaceDir,
    projectSlug,
    project,
    provider,
    autoFix: true,
    instanceName,
    workflow: resolvedConfig?.workflow,
  });
  fixedCount += statelessFixes.filter((f) => f.fixed).length;

  // Guard against dual-state-label issues (A2 — interrupted label transition)
  if (resolvedConfig) {
    const dualFixes = await fixDualStateLabels(workspaceDir, projectSlug, project, provider, resolvedConfig);
    fixedCount += dualFixes;
  }

  return fixedCount;
}

/**
 * Run review pass for a project — transition issues whose PR check condition is met.
 */
export async function performReviewPass(
  workspaceDir: string,
  projectSlug: string,
  project: Project,
  provider: import("../../providers/provider.js").IssueProvider,
  resolvedConfig: ResolvedConfig,
  pluginConfig: Record<string, unknown> | undefined,
  runtime?: PluginRuntime,
  runCommand?: RunCommand,
): Promise<number> {
  const notifyConfig = getNotificationConfig(pluginConfig);

  return reviewPass({
    workspaceDir,
    projectName: projectSlug,
    workflow: resolvedConfig.workflow,
    provider,
    repoPath: project.repo,
    gitPullTimeoutMs: resolvedConfig.timeouts.gitPullMs,
    baseBranch: project.baseBranch,
    runCommand: runCommand!,
    onMerge: (issueId, prUrl, prTitle, sourceBranch) => {
      provider
        .getIssue(issueId)
        .then((issue) => {
          const target = resolveNotifyChannel(
            issue.labels,
            project.channels,
          );
          notify(
            {
              type: "prMerged",
              project: project.name,
              issueId,
              issueUrl: issue.web_url,
              issueTitle: issue.title,
              prUrl: prUrl ?? undefined,
              prTitle,
              sourceBranch,
              mergedBy: "heartbeat",
            },
            {
              workspaceDir,
              config: notifyConfig,
              channelId: target?.channelId,
              channel: target?.channel ?? "telegram",
              runtime,
              accountId: target?.accountId,
              messageThreadId: target?.messageThreadId,
              runCommand,
            },
          ).catch(() => {});
        })
        .catch(() => {});
    },
    onFeedback: (issueId, reason, prUrl, issueTitle, issueUrl) => {
      const type =
        reason === "changes_requested"
          ? ("changesRequested" as const)
          : ("mergeConflict" as const);
      // No issue labels available in this callback — fall back to primary channel
      const target = project.channels[0];
      notify(
        {
          type,
          project: project.name,
          issueId,
          issueUrl,
          issueTitle,
          prUrl: prUrl ?? undefined,
        },
        {
          workspaceDir,
          config: notifyConfig,
          channelId: target?.channelId,
          channel: target?.channel ?? "telegram",
          runtime,
          accountId: target?.accountId,
          messageThreadId: target?.messageThreadId,
          runCommand,
        },
      ).catch(() => {});
    },
    onPrClosed: (issueId, prUrl, issueTitle, issueUrl) => {
      // No issue labels available in this callback — fall back to primary channel
      const target = project.channels[0];
      notify(
        {
          type: "prClosed",
          project: project.name,
          issueId,
          issueUrl,
          issueTitle,
          prUrl: prUrl ?? undefined,
        },
        {
          workspaceDir,
          config: notifyConfig,
          channelId: target?.channelId,
          channel: target?.channel ?? "telegram",
          runtime,
          accountId: target?.accountId,
          messageThreadId: target?.messageThreadId,
          runCommand,
        },
      ).catch(() => {});
    },
  });
}

/**
 * Run review skip pass for a project — auto-merge and transition review:skip issues through the review queue.
 */
export async function performReviewSkipPass(
  workspaceDir: string,
  projectSlug: string,
  project: Project,
  provider: import("../../providers/provider.js").IssueProvider,
  resolvedConfig: ResolvedConfig,
  pluginConfig: Record<string, unknown> | undefined,
  runtime?: PluginRuntime,
  runCommand?: RunCommand,
): Promise<number> {
  const notifyConfig = getNotificationConfig(pluginConfig);

  return reviewSkipPass({
    workspaceDir,
    projectName: projectSlug,
    workflow: resolvedConfig.workflow,
    provider,
    repoPath: project.repo,
    gitPullTimeoutMs: resolvedConfig.timeouts.gitPullMs,
    runCommand: runCommand!,
    onMerge: (issueId, prUrl, prTitle, sourceBranch) => {
      provider
        .getIssue(issueId)
        .then((issue) => {
          const target = resolveNotifyChannel(
            issue.labels,
            project.channels,
          );
          notify(
            {
              type: "prMerged",
              project: project.name,
              issueId,
              issueUrl: issue.web_url,
              issueTitle: issue.title,
              prUrl: prUrl ?? undefined,
              prTitle,
              sourceBranch,
              mergedBy: "heartbeat",
            },
            {
              workspaceDir,
              config: notifyConfig,
              channelId: target?.channelId,
              channel: target?.channel ?? "telegram",
              runtime,
              accountId: target?.accountId,
              messageThreadId: target?.messageThreadId,
              runCommand,
            },
          ).catch(() => {});
        })
        .catch(() => {});
    },
  });
}

/**
 * Run test skip pass for a project — auto-transition test:skip issues through the test queue.
 */
export async function performTestSkipPass(
  workspaceDir: string,
  projectSlug: string,
  project: Project,
  provider: import("../../providers/provider.js").IssueProvider,
  resolvedConfig: ResolvedConfig,
  runCommand?: RunCommand,
): Promise<number> {
  return testSkipPass({
    workspaceDir,
    projectName: projectSlug,
    workflow: resolvedConfig.workflow,
    provider,
    repoPath: project.repo,
    gitPullTimeoutMs: resolvedConfig.timeouts.gitPullMs,
    runCommand,
  });
}

/**
 * Run hold escape pass — close issues stuck in hold states with merged PRs.
 */
export async function performHoldEscapePass(
  workspaceDir: string,
  projectSlug: string,
  project: Project,
  provider: import("../../providers/provider.js").IssueProvider,
  resolvedConfig: ResolvedConfig,
  pluginConfig: Record<string, unknown> | undefined,
  runtime?: PluginRuntime,
  runCommand?: RunCommand,
): Promise<number> {
  const notifyConfig = getNotificationConfig(pluginConfig);

  return holdEscapePass({
    workspaceDir,
    projectName: projectSlug,
    workflow: resolvedConfig.workflow,
    provider,
    onEscape: (issueId, fromLabel, prUrl) => {
      provider
        .getIssue(issueId)
        .then((issue) => {
          const target = resolveNotifyChannel(
            issue.labels,
            project.channels,
          );
          notify(
            {
              type: "holdEscapeResolved",
              project: project.name,
              issueId,
              issueUrl: issue.web_url,
              issueTitle: issue.title,
              prUrl,
              fromState: fromLabel,
            },
            {
              workspaceDir,
              config: notifyConfig,
              channelId: target?.channelId,
              channel: target?.channel ?? "telegram",
              runtime,
              accountId: target?.accountId,
              messageThreadId: target?.messageThreadId,
              runCommand,
            },
          ).catch(() => {});
        })
        .catch(() => {});
    },
  });
}

/**
 * Reviewer poll pass — on every heartbeat tick, check active reviewer sessions for a
 * decision signal. Transitions the FSM immediately instead of waiting for stale_worker (2h).
 *
 * Each active reviewer slot is polled via `runtime.subagent.getSessionMessages`. If a
 * clear "approve" or "reject" is found the issue is advanced to the next stage and the
 * slot is deactivated. This gives ≤2-minute transition latency (one heartbeat interval).
 *
 * @returns number of transitions made.
 */
export async function performReviewerPollPass(
  workspaceDir: string,
  projectSlug: string,
  project: Project,
  provider: import("../../providers/provider.js").IssueProvider,
  resolvedConfig: ResolvedConfig,
  runtime?: PluginRuntime,
): Promise<number> {
  if (!runtime) return 0;

  const workflow = resolvedConfig.workflow;
  let activeLabel: string;
  try {
    activeLabel = getActiveLabel(workflow, "reviewer");
  } catch {
    return 0; // No reviewer role in this workflow
  }

  const reviewerWorker = project.workers["reviewer"];
  if (!reviewerWorker) return 0;

  let transitions = 0;

  for (const [level, slots] of Object.entries(reviewerWorker.levels)) {
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
      const slot = slots[slotIndex]!;
      if (!slot.active || !slot.sessionKey || !slot.issueId) continue;

      // Grace period: skip sessions that just started (< 2 min) to avoid false positives
      // from cached/stale content at session initialisation.
      const startTime = slot.startTime ? new Date(slot.startTime).getTime() : 0;
      if (startTime && (Date.now() - startTime) < 2 * 60_000) continue;

      // Read session messages and parse review decision
      const reviewResult = await handleReviewerAgentEnd({
        sessionKey: slot.sessionKey,
        runtime: runtime as any,
      });
      if (!reviewResult) continue;

      const transition = resolveReviewerDecisionTransition(workflow, reviewResult);
      if (!transition) continue;

      // Verify issue still has the active label (guard against concurrent transitions)
      let issue: Awaited<ReturnType<typeof provider.getIssue>>;
      try {
        issue = await provider.getIssue(Number(slot.issueId));
      } catch {
        continue;
      }
      if (!issue.labels.includes(activeLabel)) {
        await deactivateWorker(workspaceDir, projectSlug, "reviewer", {
          level,
          slotIndex,
        });
        await auditLog(workspaceDir, "reviewer_poll_slot_released", {
          sessionKey: slot.sessionKey,
          project: project.name,
          projectSlug,
          issueId: slot.issueId,
          from: activeLabel,
          currentLabels: issue.labels,
          reason: "issue_already_moved",
        }).catch(() => {});
        continue;
      }

      // Transition label and deactivate slot
      await resilientLabelTransition(provider, Number(slot.issueId), activeLabel, transition.targetLabel);
      await deactivateWorker(workspaceDir, projectSlug, "reviewer", {
        level,
        slotIndex,
      });

      await auditLog(workspaceDir, "reviewer_poll_transition", {
        sessionKey: slot.sessionKey,
        project: project.name,
        projectSlug,
        issueId: slot.issueId,
        result: reviewResult,
        eventKey: transition.eventKey,
        from: activeLabel,
        to: transition.targetLabel,
      }).catch(() => {});

      transitions++;
    }
  }

  return transitions;
}
