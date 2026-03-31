/**
 * work_finish — Complete a task (DEV done, QA pass/fail/refine/blocked, architect done/blocked).
 *
 * Delegates side-effects to pipeline service: label transition, state update,
 * issue close/reopen, notifications, and audit logging.
 *
 * All roles (including architect) use the standard pipeline via executeCompletion.
 * Architect workflow: Researching → Done (done, closes issue), Researching → Refining (blocked).
 */
import { jsonResult } from "../../runtime/plugin-sdk-compat.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolContext } from "../../types.js";
import type { PluginContext, RunCommand } from "../../context.js";
import { getRoleWorker, recordIssueLifecycle, recordIssueLifecycleBySessionKey, resolveRepoPath, updateIssueRuntime, requireCanonicalPrSelector, deactivateWorker } from "../../projects/index.js";
import { executeCompletion, getRule } from "../../services/pipeline.js";
import { log as auditLog } from "../../audit.js";
import { DATA_DIR } from "../../setup/constants.js";
import { requireWorkspaceDir, resolveProjectFromContext, resolveProvider } from "../helpers.js";
import { getAllRoleIds, isValidResult, getCompletionResults } from "../../roles/index.js";
import { getQueueLabels, isFeedbackState } from "../../workflow/index.js";
import { resilientLabelTransition, resolveNotifyChannel } from "../../workflow/labels.js";
import { notify, getNotificationConfig } from "../../dispatch/notify.js";
import { loadConfig } from "../../config/index.js";
import { PrState, type PrSelector } from "../../providers/provider.js";
import {
  formatQaEvidenceValidationFailure,
  validateCanonicalQaEvidence,
  type QaEvidenceValidation,
} from "../tasks/qa-evidence.js";
import { getRootLogger } from "../../observability/logger.js";

/**
 * Get the current git branch name.
 */
async function getCurrentBranch(repoPath: string, runCommand: RunCommand): Promise<string> {
  const result = await runCommand(["git", "branch", "--show-current"], {
    timeoutMs: 5_000,
    cwd: repoPath,
  });
  return result.stdout.trim();
}

function throwInvalidQaEvidence(
  qaEvidence: QaEvidenceValidation,
  actor: "developer" | "reviewer",
): never {
  throw new Error(formatQaEvidenceValidationFailure(qaEvidence, actor));
}


/**
 * Check if this work_finish is completing a conflict resolution cycle.
 * Returns true if the issue was recently transitioned to "To Improve" due to merge conflicts.
 * Used to gate mergeable-status validation — without this check, developers can claim
 * success after local rebase but before pushing, causing infinite dispatch loops (#482).
 *
 * Primary: checks issueRuntime.lastConflictDetectedAt (survives audit.log rotation).
 * Fallback: scans audit.log + backup files.
 */
async function isConflictResolutionCycle(
  workspaceDir: string,
  issueId: number,
  issueRuntime?: import("../../projects/types.js").IssueRuntimeState | null,
): Promise<boolean> {
  // Primary: check issueRuntime — survives audit log rotation
  if (issueRuntime?.lastConflictDetectedAt) {
    return true;
  }

  // Fallback: scan audit.log + backup files
  const auditPath = join(workspaceDir, DATA_DIR, "log", "audit.log");
  const backupPaths = [
    `${auditPath}.bak`,
    `${auditPath}.2.bak`,
    `${auditPath}.3.bak`,
  ];

  for (const filePath of [auditPath, ...backupPaths]) {
    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]!);
          if (
            entry.issueId === issueId &&
            entry.event === "review_transition" &&
            entry.reason === "merge_conflict"
          ) {
            return true;
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // File not found or unreadable — try next backup
    }
  }
  return false;
}

/**
 * Validate that a developer has created an OPEN PR for their work.
 * Throws an error if no open PR is found for the issue.
 *
 * How getPrStatus signals "no PR":
 *   - Returns `{ url: null }` when no open or merged PR is linked to the issue.
 *   - Developer completion requires an open/reviewable PR, not historical merged work.
 */
export async function validatePrExistsForDeveloper(
  issueId: number,
  repoPath: string,
  provider: Awaited<ReturnType<typeof resolveProvider>>["provider"],
  runCommand: RunCommand,
  workspaceDir: string,
  projectSlug: string,
  issueRuntime?: import("../../projects/types.js").IssueRuntimeState | null,
): Promise<import("../../providers/provider.js").PrStatus> {
  const logger = getRootLogger().child({ issueId, phase: "work-finish" });
  const branchName = await getCurrentBranch(repoPath, runCommand).catch(() => "");
  try {
    const branchPr = branchName ? await provider.findOpenPrForBranch(branchName) : null;
    const prStatus = branchPr ?? await provider.getPrStatus(issueId);

    // Developer completion requires an OPEN PR. Historical merged PRs are not enough,
    // otherwise the reviewer/tester pipeline can be re-entered without a reviewable artifact.
    if (!prStatus.url || prStatus.state === PrState.MERGED || prStatus.state === PrState.CLOSED) {
      // Get current branch for a helpful gh pr create example
      const currentBranch = branchName || "current-branch";

      const reason = !prStatus.url
        ? `✗ No PR found for branch: ${currentBranch}`
        : prStatus.state === PrState.MERGED
          ? `✗ Last linked PR is already merged: ${prStatus.url}`
          : `✗ Last linked PR is closed and not reviewable: ${prStatus.url}`;

      throw new Error(
        `Cannot mark work_finish(done) without an open PR.\n\n` +
        `${reason}\n\n` +
        `Please create a PR first:\n` +
        `  gh pr create --base main --head ${currentBranch} --title "..." --body "..."\n\n` +
        `Then call work_finish again.`,
      );
    }

    // url is set and the PR is still open/reviewable.
    if (branchPr && (!branchPr.linkedIssueIds?.length || !branchPr.linkedIssueIds.includes(issueId))) {
      throw new Error(
        `Cannot mark work_finish(done) with a PR that no longer targets issue #${issueId}.\n\n` +
        `✗ PR: ${branchPr.url}\n` +
        `✗ Current issue refs on PR: ${branchPr.linkedIssueIds?.length ? (branchPr.linkedIssueIds ?? []).map((id) => `#${id}`).join(", ") : "(none in title/body)"}\n` +
        `✗ Branch-only refs are not accepted as canonical ownership.\n\n` +
        `Open or retarget a PR that explicitly addresses issue #${issueId}, then call work_finish again.`,
      );
    }

    // Mark PR as "seen" (with eyes emoji) if not already marked.
    // This helps distinguish system-created PRs from human responses.
    // Best-effort — don't block completion if this fails.
    try {
      const hasEyes = await provider.prHasReaction(issueId, "eyes");
      if (!hasEyes) {
        await provider.reactToPr(issueId, "eyes");
      }
    } catch {
      // Ignore errors — marking is cosmetic
    }

    // Conflict resolution validation: When an issue returns from "To Improve" due to
    // merge conflicts, we must verify the PR is actually mergeable before accepting
    // work_finish(done). Without this check, developers can claim success after local
    // rebase but before pushing, causing infinite dispatch loops (#482).
    const isConflictCycle = await isConflictResolutionCycle(workspaceDir, issueId, issueRuntime);

    if (isConflictCycle && prStatus.mergeable === false) {
      await auditLog(workspaceDir, "work_finish_rejected", {
        project: projectSlug,
        issue: issueId,
        reason: "pr_still_conflicting",
        prUrl: prStatus.url,
      });

      const branchName = prStatus.sourceBranch || "your-branch";
      throw new Error(
        `Cannot complete work_finish(done) while PR still shows merge conflicts.\n\n` +
        `✗ PR status: CONFLICTING\n` +
        `✗ PR URL: ${prStatus.url}\n` +
        `✗ Branch: ${branchName}\n\n` +
        `Your local rebase may have succeeded, but changes must be pushed to the remote.\n\n` +
        `Verify your changes were pushed:\n` +
        `  git log origin/${branchName}..HEAD\n` +
        `  # Should show no commits (meaning everything is pushed)\n\n` +
        `If unpushed commits exist, push them:\n` +
        `  git push --force-with-lease origin ${branchName}\n\n` +
        `Wait a few seconds for GitHub to update, then verify the PR:\n` +
        `  gh pr view ${issueId}\n` +
        `  # Should show "Mergeable" status\n\n` +
        `Once the PR shows as mergeable on GitHub, call work_finish again.`,
      );
    }

    if (isConflictCycle) {
      await auditLog(workspaceDir, "conflict_resolution_verified", {
        project: projectSlug,
        issue: issueId,
        prUrl: prStatus.url,
        mergeable: prStatus.mergeable,
      });
    }

    const qaEvidence = validateCanonicalQaEvidence(prStatus.body);
    if (!qaEvidence.valid) {
      await auditLog(workspaceDir, "work_finish_rejected", {
        project: projectSlug,
        issue: issueId,
        reason: "invalid_qa_evidence",
        role: "developer",
        result: "done",
        prUrl: prStatus.url,
        qaProblems: qaEvidence.problems,
      });
      throwInvalidQaEvidence(qaEvidence, "developer");
    }
    return prStatus;
  } catch (err) {
    if (err instanceof Error && (err.message.startsWith("Cannot mark work_finish(done)") || err.message.startsWith("Cannot complete work_finish(done)"))) {
      throw err;
    }
    logger.warn({ err }, "PR validation warning; failing closed");
    throw new Error(
      `Cannot mark work_finish(done) because Fabrica could not verify PR state right now.\n\n` +
      `Resolve the provider/API error and call work_finish again.`,
    );
  }
}

function shouldAutoRecoverToFeedback(summary?: string): boolean {
  if (!summary) return false;
  const text = summary.toLowerCase();
  return (
    /retarget/.test(text) ||
    /mismatch de escopo/.test(text) ||
    /mismatch de escopo\/rastreabilidade/.test(text) ||
    /new pr/.test(text) ||
    /novo pr/.test(text) ||
    /não pode satisfazer a issue/.test(text) ||
    /cannot satisfy issue/.test(text)
  );
}

export async function getCanonicalQaEvidenceValidationForPr(
  provider: Awaited<ReturnType<typeof resolveProvider>>["provider"],
  issueId: number,
  selector?: PrSelector,
): Promise<QaEvidenceValidation> {
  const prStatus = await provider.getPrStatus(issueId, selector);
  return validateCanonicalQaEvidence(prStatus.body);
}

export const INFRA_FAIL_CIRCUIT_BREAKER_THRESHOLD = 2;

export function createWorkFinishTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "work_finish",
    label: "Work Finish",
    description: `Complete a task: Developer done (PR created, goes to review) or blocked. Tester pass/fail/fail_infra/refine/blocked. Architect done/blocked. Handles label transition, state update, issue close/reopen, notifications, and audit logging.`,
    parameters: {
      type: "object",
      required: ["channelId", "role", "result"],
      properties: {
        channelId: { type: "string", description: "Project slug (e.g. 'my-project'). Use the value from the 'Channel:' line in your task message. Do NOT use a numeric Telegram chat ID." },
        role: { type: "string", enum: getAllRoleIds(), description: "Worker role" },
        result: { type: "string", enum: ["done", "pass", "fail", "fail_infra", "refine", "blocked"], description: "Completion result. Use fail_infra (tester only) when the test toolchain is missing or broken — this keeps the issue in the test queue instead of routing it to the developer." },
        summary: { type: "string", description: "Brief summary" },
        prUrl: { type: "string", description: "PR/MR URL (auto-detected if omitted)" },
        createdTasks: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "title", "url"],
            properties: {
              id: { type: "number", description: "Issue ID" },
              title: { type: "string", description: "Issue title" },
              url: { type: "string", description: "Issue URL" },
            },
          },
          description: "Tasks created during this work session (architect creates implementation tasks).",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const role = params.role as string;
      const result = params.result as string;
      const summary = params.summary as string | undefined;
      const prUrl = params.prUrl as string | undefined;
      const createdTasks = params.createdTasks as Array<{ id: number; title: string; url: string }> | undefined;
      const dispatchRunId = typeof params._dispatchRunId === "string"
        ? params._dispatchRunId
        : undefined;
      const workspaceDir = requireWorkspaceDir(toolCtx);

      if (role === "reviewer") {
        throw new Error(
          "Reviewer completion is no longer handled by work_finish. End your response with exactly one plain-text decision line: 'Review result: APPROVE' or 'Review result: REJECT'. Use the project slug from the 'Channel:' line in your task message for any follow-up task_create call.",
        );
      }

      // Validate role:result using registry
      if (!isValidResult(role, result)) {
        const valid = getCompletionResults(role);
        throw new Error(`${role.toUpperCase()} cannot complete with "${result}". Valid results: ${valid.join(", ")}`);
      }

      // Resolve project + worker
      const { project, route } = await resolveProjectFromContext(workspaceDir, toolCtx, params.channelId as string | undefined);
      const roleWorker = getRoleWorker(project, role);

      const workerSlot = resolveWorkerSlot(roleWorker, toolCtx.sessionKey);

      if (!workerSlot) {
        throw new Error(`${role.toUpperCase()} worker not active on ${project.name}`);
      }
      const { slotIndex, slotLevel, issueId, recovered } = workerSlot;
      const issueRuntime = project.issueRuntime?.[String(issueId)];
      const currentDispatchRunId = workerSlot.dispatchRunId ?? issueRuntime?.dispatchRunId ?? null;
      const hasCycleMismatch = Boolean(
        workerSlot.dispatchCycleId &&
        issueRuntime?.lastDispatchCycleId &&
        workerSlot.dispatchCycleId !== issueRuntime.lastDispatchCycleId,
      );

      if (!dispatchRunId || !currentDispatchRunId || dispatchRunId !== currentDispatchRunId || hasCycleMismatch) {
        await auditLog(workspaceDir, "work_finish_rejected", {
          project: project.name,
          projectSlug: project.slug,
          issue: issueId,
          role,
          result,
          reason: "stale_dispatch_cycle",
          sessionKey: toolCtx.sessionKey ?? null,
          providedDispatchRunId: dispatchRunId ?? null,
          currentDispatchRunId,
          slotDispatchCycleId: workerSlot.dispatchCycleId ?? null,
          runtimeDispatchCycleId: issueRuntime?.lastDispatchCycleId ?? null,
        });
        return jsonResult({
          success: false,
          project: project.name,
          projectSlug: project.slug,
          issueId,
          role,
          result,
          reason: "stale_dispatch_cycle",
        });
      }

      await recordIssueLifecycleBySessionKey({
        workspaceDir,
        sessionKey: toolCtx.sessionKey,
        stage: "first_worker_activity",
        details: { source: "work_finish" },
      }).catch(() => {});

      const prSelector = (role === "reviewer" || role === "tester")
        ? requireCanonicalPrSelector(project, issueId, `${role} completion`)
        : (issueRuntime?.currentPrNumber ? { prNumber: issueRuntime.currentPrNumber } : undefined);
      if (recovered) {
        await auditLog(workspaceDir, "work_finish_recovered_slot", {
          project: project.name,
          role,
          issue: issueId,
          sessionKey: toolCtx.sessionKey ?? null,
        });
      }

      const { provider } = await resolveProvider(project, ctx.runCommand, ctx.pluginConfig);
      const resolvedConfig = await loadConfig(workspaceDir, project.slug);
      const workflow = resolvedConfig.workflow;

      await auditLog(workspaceDir, "workflow_resolution", {
        project: project.name,
        issue: issueId,
        role,
        sourceLayers: resolvedConfig.workflowMeta.sourceLayers,
        workflowHash: resolvedConfig.workflowMeta.hash,
        normalizationFixes: resolvedConfig.workflowMeta.normalizationFixes.map((fix) => ({
          stateKey: fix.stateKey,
          event: fix.event,
          removedActions: fix.removedActions,
          addedActions: fix.addedActions ?? [],
          reason: fix.reason,
        })),
        keyTransitions: resolvedConfig.workflowMeta.keyTransitions,
      });

      // --- fail_infra special case: no workflow rule, handled directly ---
      if (role === "tester" && result === "fail_infra") {
        const currentInfraFails = (issueRuntime?.infraFailCount ?? 0) + 1;
        await updateIssueRuntime(workspaceDir, project.slug, issueId, {
          infraFailCount: currentInfraFails,
        });

        await auditLog(workspaceDir, "infra_failure", {
          project: project.name, issue: issueId, role, result,
          summary: summary ?? null, infraFailCount: currentInfraFails,
        });

        // Notify operator
        const notifyConfig = getNotificationConfig(ctx.pluginConfig);
        const target = resolveNotifyChannel([], project.channels);
        const issueUrl = `https://github.com/${project.repo}/issues/${issueId}`;
        await notify(
          {
            type: "infraFailure",
            project: project.name,
            issueId,
            issueUrl,
            summary: summary ?? "Infrastructure failure during testing",
            infraFailCount: currentInfraFails,
          },
          {
            workspaceDir,
            config: notifyConfig,
            channelId: target?.channelId,
            channel: target?.channel ?? "telegram",
            runtime: ctx.runtime,
            accountId: target?.accountId,
            messageThreadId: target?.messageThreadId,
            runCommand: ctx.runCommand,
          },
        ).catch((err) => { getRootLogger().warn(`infra_failure notification failed: ${err}`); });

        // Circuit breaker: after INFRA_FAIL_CIRCUIT_BREAKER_THRESHOLD infra failures, move to Refining (hold state)
        if (currentInfraFails >= INFRA_FAIL_CIRCUIT_BREAKER_THRESHOLD) {
          await auditLog(workspaceDir, "infra_failure_circuit_breaker", {
            project: project.name, issue: issueId, infraFailCount: currentInfraFails,
          });
          await resilientLabelTransition(provider, issueId, "Testing", "Refining");
        } else {
          // Stay in test queue — will be re-dispatched after toolchain is fixed
          await resilientLabelTransition(provider, issueId, "Testing", "To Test");
        }

        // Release worker slot
        await deactivateWorker(workspaceDir, project.slug, "tester", {
          level: slotLevel,
          slotIndex,
          issueId: String(issueId),
        });

        await recordIssueLifecycle({
          workspaceDir,
          slug: project.slug,
          issueId,
          stage: "session_completed",
          sessionKey: toolCtx.sessionKey ?? null,
          details: { role, result, infraFailCount: currentInfraFails },
        }).catch(() => {});

        return jsonResult({
          success: true, project: project.name, projectSlug: project.slug,
          issueId, role, result, infraFailCount: currentInfraFails,
          circuitBroken: currentInfraFails >= INFRA_FAIL_CIRCUIT_BREAKER_THRESHOLD,
        });
      }

      if (!getRule(role, result, workflow))
        throw new Error(`Invalid completion: ${role}:${result}`);

      const repoPath = resolveRepoPath(project.repo);
      const pluginConfig = ctx.pluginConfig;

      // For developers marking work as done, validate that a PR exists
      let developerPrStatus: import("../../providers/provider.js").PrStatus | undefined;
      if (role === "developer" && result === "done") {
        developerPrStatus = await validatePrExistsForDeveloper(issueId, repoPath, provider, ctx.runCommand, workspaceDir, project.slug, project.issueRuntime?.[String(issueId)]);
        await updateIssueRuntime(workspaceDir, project.slug, issueId, {
          currentPrNodeId: developerPrStatus.nodeId ?? null,
          currentPrNumber: developerPrStatus.number ?? null,
          currentPrUrl: developerPrStatus.url ?? null,
          currentPrState: developerPrStatus.state,
          currentPrSourceBranch: developerPrStatus.sourceBranch ?? null,
          currentPrIssueTarget: developerPrStatus.linkedIssueIds?.includes(issueId) ? issueId : null,
          bindingSource: developerPrStatus.bindingSource === "selector"
            ? "explicit"
            : (developerPrStatus.bindingSource ?? "explicit"),
          bindingConfidence: developerPrStatus.bindingConfidence ?? "high",
          lastResolvedIssueTarget: issueId,
          followUpPrRequired: false,
          boundAt: new Date().toISOString(),
        });
      }
      const feedbackQueueLabel = getQueueLabels(workflow, "developer")
        .find((label) => isFeedbackState(workflow, label)) ?? null;
      const autoRecoverToFeedback = role === "developer" &&
        result === "blocked" &&
        feedbackQueueLabel &&
        shouldAutoRecoverToFeedback(summary);
      if (autoRecoverToFeedback) {
        await updateIssueRuntime(workspaceDir, project.slug, issueId, {
          currentPrNodeId: null,
          currentPrNumber: null,
          currentPrUrl: null,
          currentPrState: null,
          currentPrSourceBranch: null,
          currentPrIssueTarget: null,
          bindingSource: "none",
          bindingConfidence: "low",
          followUpPrRequired: true,
          lastRejectedPrNumber: issueRuntime?.currentPrNumber ?? null,
          lastResolvedIssueTarget: issueRuntime?.currentPrIssueTarget ?? null,
          boundAt: new Date().toISOString(),
        });
      }
      const completion = await ctx.observability.withContext({
        sessionKey: toolCtx.sessionKey ?? undefined,
        issueId,
        prNumber: issueRuntime?.currentPrNumber ?? developerPrStatus?.number ?? undefined,
        headSha: issueRuntime?.currentPrHeadSha ?? undefined,
        phase: "pipeline",
      }, () => ctx.observability.withSpan("fabrica.pipeline.run", {
        sessionKey: toolCtx.sessionKey ?? undefined,
        issueId,
        prNumber: issueRuntime?.currentPrNumber ?? developerPrStatus?.number ?? undefined,
        headSha: issueRuntime?.currentPrHeadSha ?? undefined,
        phase: "pipeline",
      }, async () => {
        const stageSpanName = role === "reviewer"
          ? "fabrica.pipeline.review"
          : role === "tester"
            ? "fabrica.pipeline.test"
            : "fabrica.pipeline.run";
        return ctx.observability.withSpan(stageSpanName, {
          sessionKey: toolCtx.sessionKey ?? undefined,
          issueId,
          prNumber: issueRuntime?.currentPrNumber ?? developerPrStatus?.number ?? undefined,
          headSha: issueRuntime?.currentPrHeadSha ?? undefined,
          role,
          result,
        }, async () => executeCompletion({
          workspaceDir, projectSlug: project.slug, role, result, issueId, summary, prUrl, provider, repoPath,
          projectName: project.name,
          channels: project.channels,
          pluginConfig,
          level: slotLevel,
          slotIndex,
          runtime: ctx.runtime,
          workflow,
          createdTasks,
          overrideToLabel: autoRecoverToFeedback ? feedbackQueueLabel ?? undefined : undefined,
          overrideReason: autoRecoverToFeedback ? "new_pr_required" : undefined,
          runCommand: ctx.runCommand,
        }));
      }));

      await auditLog(workspaceDir, "work_finish", {
        project: project.name, issue: issueId, role, result,
        summary: summary ?? null, labelTransition: completion.labelTransition,
      });

      await recordIssueLifecycle({
        workspaceDir,
        slug: project.slug,
        issueId,
        stage: "session_completed",
        sessionKey: toolCtx.sessionKey ?? null,
        details: { role, result },
      }).catch(() => {});

      // Reset infra fail counter after successful tester completion
      if (role === "tester" && issueRuntime?.infraFailCount) {
        await updateIssueRuntime(workspaceDir, project.slug, issueId, { infraFailCount: 0 });
      }

      // Reset diagnostic escalation counters after successful work_finish (v0.2.0)
      if (issueRuntime && (issueRuntime.dispatchAttemptCount || issueRuntime.lastFailureReason || issueRuntime.lastDiagnosticResult || issueRuntime.lastDispatchedLevel)) {
        await updateIssueRuntime(workspaceDir, project.slug, issueId, {
          dispatchAttemptCount: 0,
          lastFailureReason: null,
          lastDiagnosticResult: null,
          lastDispatchedLevel: null,
        });
      }

      return jsonResult({
        success: true, project: project.name, projectSlug: project.slug, issueId, role, result,
        ...completion,
      });
    },
  });
}

export function resolveWorkerSlot(
  roleWorker: ReturnType<typeof getRoleWorker>,
  sessionKey?: string,
): {
  slotIndex: number;
  slotLevel: string;
  issueId: number;
  recovered: boolean;
  dispatchCycleId?: string | null;
  dispatchRunId?: string | null;
} | null {
  for (const [level, slots] of Object.entries(roleWorker.levels)) {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      if (!slot.active || !slot.issueId) continue;
      if (!sessionKey || !slot.sessionKey || slot.sessionKey === sessionKey) {
        return {
          slotIndex: i,
          slotLevel: level,
          issueId: Number(slot.issueId),
          recovered: false,
          dispatchCycleId: slot.dispatchCycleId ?? null,
          dispatchRunId: slot.dispatchRunId ?? null,
        };
      }
    }
  }

  if (!sessionKey) return null;

  for (const [level, slots] of Object.entries(roleWorker.levels)) {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      if (slot.active || !slot.lastIssueId || slot.sessionKey !== sessionKey) continue;
      return {
        slotIndex: i,
        slotLevel: level,
        issueId: Number(slot.lastIssueId),
        recovered: true,
        dispatchCycleId: slot.dispatchCycleId ?? null,
        dispatchRunId: slot.dispatchRunId ?? null,
      };
    }
  }

  return null;
}
