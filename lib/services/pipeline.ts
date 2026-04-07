/**
 * Pipeline service — declarative completion rules.
 *
 * Uses workflow config to determine transitions and side effects.
 */
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { PrState, type StateLabel, type IssueProvider, type PrStatus } from "../providers/provider.js";
import { deactivateWorker, loadProjectBySlug, getRoleWorker, getIssueRuntime, clearIssueRuntime, updateIssueRuntime } from "../projects/index.js";
import type { Channel, Project } from "../projects/index.js";
import type { PrSelector } from "../providers/provider.js";
import type { RunCommand } from "../context.js";
import { notify, getNotificationConfig } from "../dispatch/notify.js";
import { log as auditLog } from "../audit.js";
import { loadConfig } from "../config/index.js";
import type { DeliveryTarget } from "../intake/types.js";
import { detectStepRouting } from "./queue-scan.js";
import { reconcileParentLifecycleForIssue } from "./parent-lifecycle.js";
import {
  DEFAULT_WORKFLOW,
  Action,
  getCompletionRule,
  getNextStateDescription,
  getCompletionEmoji,
  resolveNotifyChannel,
  TestPolicy,
  WorkflowEvent,
  type CompletionRule,
  type WorkflowConfig,
} from "../workflow/index.js";
import { withCorrelationContext } from "../observability/context.js";
import { withTelemetrySpan } from "../observability/telemetry.js";
import { resolveQualityGatePolicy } from "../quality/quality-gates.js";
import { resolveDonePolicy } from "../quality/done-policies.js";

export type { CompletionRule };

export type CompletionOutput = {
  labelTransition: string;
  announcement: string;
  nextState: string;
  prUrl?: string;
  issueUrl?: string;
  issueClosed?: boolean;
  issueReopened?: boolean;
  finalAcceptance?: FinalAcceptanceSummary;
};

export type FinalAcceptanceSummary = {
  deliverable: string;
  fidelityStatus: "pass" | "warn";
  qualityGateStatus: "pass" | "warn";
  evidenceStatus: "pass" | "fail";
  donePolicyStatus: "pass" | "warn";
  openConcerns: string[];
};

export type CloseGuardIssueRuntime = {
  artifactOfRecord?: {
    prNumber: number;
    headSha?: string | null;
    mergedAt: string;
    url?: string | null;
  } | null;
  currentPrNumber?: number | null;
  currentPrUrl?: string | null;
  currentPrState?: string | null;
  lastHeadSha?: string | null;
  lastRunId?: string | null;
  lastCheckRunId?: number | null;
};

export type CloseGuardEvaluation = {
  allowed: boolean;
  reason?: "open_pr" | "missing_artifact_of_record" | "follow_up_pr_required";
  currentPrNumber?: number | null;
};

function hasMeaningfulCompletionEvidence(summary?: string, prUrl?: string, createdTasks?: Array<{ id: number; title: string; url: string }>): boolean {
  if (summary && summary.trim().length >= 12) return true;
  if (prUrl && prUrl.trim().length > 0) return true;
  if (createdTasks && createdTasks.length > 0) return true;
  return false;
}

function hasArchetypeSpecificEvidence(deliverable: DeliveryTarget, summary?: string, prUrl?: string, createdTasks?: Array<{ id: number; title: string; url: string }>): boolean {
  if (prUrl && prUrl.trim().length > 0) return true;
  if (createdTasks && createdTasks.length > 0) return true;
  const text = (summary ?? "").toLowerCase();
  if (!text) return deliverable === "unknown";
  if (deliverable === "cli") return /cli|command|help|exit|argv|flag|terminal/.test(text);
  if (deliverable === "api") return /api|endpoint|route|request|response|validation|handler/.test(text);
  if (deliverable === "web-ui") return /ui|screen|page|render|flow|loading|error|form/.test(text);
  if (deliverable === "hybrid") return /api|ui|flow|integration|endpoint|screen/.test(text);
  return true;
}

function buildFinalAcceptanceSummary(opts: {
  deliverable: string;
  qualityPolicy: { requiredChecks: string[]; requiredEvidence: string[] };
  donePolicy: { requiredArtifacts: string[]; requiredEvidence: string[] };
  hasEvidence: boolean;
  closeRequested: boolean;
  qualityCriticality: "low" | "medium" | "high";
  riskProfile: string[];
}): FinalAcceptanceSummary {
  const openConcerns: string[] = [];
  if (!opts.hasEvidence) openConcerns.push("missing_meaningful_completion_evidence");
  if (opts.deliverable === "unknown") openConcerns.push("deliverable_inference_is_unknown");
  if (!opts.closeRequested) openConcerns.push("completion_did_not_request_close");
  if (opts.qualityCriticality === "high") openConcerns.push("quality_criticality_high_requires_conservative_review");
  if (opts.riskProfile.length > 0) openConcerns.push(...opts.riskProfile.map((risk) => `risk:${risk}`));

  return {
    deliverable: opts.deliverable,
    fidelityStatus: opts.deliverable === "unknown" ? "warn" : "pass",
    qualityGateStatus: opts.qualityPolicy.requiredChecks.length > 0 ? "pass" : "warn",
    evidenceStatus: opts.hasEvidence ? "pass" : "fail",
    donePolicyStatus: opts.donePolicy.requiredArtifacts.length > 0 ? "pass" : "warn",
    openConcerns,
  };
}

function resolvePipelineDeliverable(project?: Project | null): DeliveryTarget {
  const stack = project?.environment?.stack ?? project?.stack ?? null;
  if (stack === "nextjs") return "web-ui";
  if (stack === "node-cli" || stack === "python-cli") return "cli";
  if (stack === "express" || stack === "fastapi" || stack === "flask" || stack === "django") return "api";

  const nameText = `${project?.name ?? ""} ${project?.slug ?? ""} ${project?.repo ?? ""}`.toLowerCase();
  if (/\bcli\b|command/.test(nameText)) return "cli";
  if (/\bapi\b|service|backend/.test(nameText)) return "api";
  if (/dashboard|frontend|web|ui/.test(nameText)) return "web-ui";
  return "unknown";
}

function buildHumanAcceptanceSummary(summary: FinalAcceptanceSummary): string {
  const badges: string[] = [];
  badges.push(`deliverable=${summary.deliverable}`);
  badges.push(`evidence=${summary.evidenceStatus}`);
  if (summary.fidelityStatus !== "pass") badges.push(`fidelity=${summary.fidelityStatus}`);
  if (summary.qualityGateStatus !== "pass") badges.push(`quality=${summary.qualityGateStatus}`);
  if (summary.donePolicyStatus !== "pass") badges.push(`done=${summary.donePolicyStatus}`);

  const concerns = summary.openConcerns.filter((c) =>
    c === "quality_criticality_high_requires_conservative_review" ||
    c.startsWith("risk:") ||
    c === "deliverable_inference_is_unknown",
  );
  if (concerns.length > 0) {
    badges.push(`concerns=${concerns.slice(0, 3).join(",")}`);
  }
  return badges.join(" | ");
}

export async function persistMergedArtifact(opts: {
  workspaceDir: string;
  projectSlug: string;
  issueId: number;
  issueRuntime?: {
    currentPrNumber?: number | null;
    currentPrUrl?: string | null;
    currentPrHeadSha?: string | null;
    lastHeadSha?: string | null;
  };
  prUrl?: string | null;
  headSha?: string | null;
}): Promise<void> {
  const { workspaceDir, projectSlug, issueId, issueRuntime, prUrl, headSha } = opts;
  const prNumber = issueRuntime?.currentPrNumber ?? null;
  if (!prNumber) return;
  await updateIssueRuntime(workspaceDir, projectSlug, issueId, {
    artifactOfRecord: {
      prNumber,
      headSha: headSha ?? issueRuntime?.currentPrHeadSha ?? issueRuntime?.lastHeadSha ?? null,
      mergedAt: new Date().toISOString(),
      url: prUrl ?? issueRuntime?.currentPrUrl ?? null,
    },
    currentPrState: PrState.MERGED,
    followUpPrRequired: false,
  }).catch((err) => {
    console.warn(
      JSON.stringify({ projectSlug, issueId, prNumber, error: String(err) }),
      "persistMergedArtifact failed — issue close guard may not find merge evidence",
    );
  });
}

export async function guardedCloseIssue(opts: {
  workspaceDir: string;
  projectName: string;
  projectSlug: string;
  issueId: number;
  role: string;
  provider: IssueProvider;
  selector?: PrSelector;
  issueRuntime?: {
    artifactOfRecord?: {
      prNumber: number;
      headSha?: string | null;
      mergedAt: string;
      url?: string | null;
    } | null;
    currentPrNumber?: number | null;
    currentPrUrl?: string | null;
    currentPrState?: string | null;
    lastHeadSha?: string | null;
    lastRunId?: string | null;
    lastCheckRunId?: number | null;
  };
  followUpPrRequired?: boolean;
}): Promise<void> {
  await assertIssueCanClose({
    workspaceDir: opts.workspaceDir,
    projectName: opts.projectName,
    projectSlug: opts.projectSlug,
    issueId: opts.issueId,
    role: opts.role,
    provider: opts.provider,
    selector: opts.selector,
    issueRuntime: opts.issueRuntime,
    followUpPrRequired: opts.followUpPrRequired,
    closeRequested: true,
  });
  await opts.provider.closeIssue(opts.issueId);
  await clearIssueRuntime(opts.workspaceDir, opts.projectSlug, opts.issueId);
}

/**
 * Get completion rule for a role:result pair.
 * Uses workflow config when available.
 */
export function getRule(
  role: string,
  result: string,
  workflow: WorkflowConfig = DEFAULT_WORKFLOW,
): CompletionRule | undefined {
  return getCompletionRule(workflow, role, result) ?? undefined;
}

/**
 * Execute the completion side-effects for a role:result pair.
 */
export async function executeCompletion(opts: {
  workspaceDir: string;
  projectSlug: string;
  role: string;
  result: string;
  issueId: number;
  summary?: string;
  prUrl?: string;
  provider: IssueProvider;
  repoPath: string;
  projectName: string;
  channels: Channel[];
  pluginConfig?: Record<string, unknown>;
  /** Plugin runtime for direct API access (avoids CLI subprocess timeouts) */
  runtime?: PluginRuntime;
  /** Workflow config (defaults to DEFAULT_WORKFLOW) */
  workflow?: WorkflowConfig;
  /** Tasks created during this work session (e.g. architect implementation tasks) */
  createdTasks?: Array<{ id: number; title: string; url: string }>;
  /** Level of the completing worker */
  level?: string;
  /** Slot index within the level's array */
  slotIndex?: number;
  /** Optional deterministic recovery target when the default workflow rule is too coarse. */
  overrideToLabel?: string;
  /** Audit hint for override-driven recovery. */
  overrideReason?: string;
  runCommand: RunCommand;
}): Promise<CompletionOutput> {
  const rc = opts.runCommand;
  const {
    workspaceDir, projectSlug, role, result, issueId, summary, provider,
    repoPath, projectName, channels, pluginConfig, runtime,
    workflow = DEFAULT_WORKFLOW,
    createdTasks,
  } = opts;

  const key = `${role}:${result}`;
  const rule = getCompletionRule(workflow, role, result);
  if (!rule) throw new Error(`No completion rule for ${key}`);
  let completionRule = rule;
  let effectiveResult = result;
  let effectiveSummary = summary;
  if (opts.overrideToLabel && opts.overrideToLabel !== rule.to) {
    completionRule = {
      from: rule.from,
      to: opts.overrideToLabel,
      actions: [],
    };
  }

  const { timeouts } = await loadConfig(workspaceDir, projectName);
  let prUrl = opts.prUrl;
  let mergedPr = false;
  let prTitle: string | undefined;
  let sourceBranch: string | undefined;
  let mergedArtifactHeadSha: string | undefined;
  const project = await loadProjectBySlug(workspaceDir, projectSlug);
  const issueRuntime = project ? getIssueRuntime(project, issueId) : undefined;
  const deliverable = resolvePipelineDeliverable(project);
  const qualityCriticality = issueRuntime?.qualityCriticality ?? "medium";
  const qualityPolicy = resolveQualityGatePolicy({ deliverable, qualityCriticality });
  const donePolicy = resolveDonePolicy({ deliverable, qualityCriticality: qualityPolicy.qualityCriticalityFloor });
  const prSelector: PrSelector | undefined = issueRuntime?.currentPrNumber
    ? { prNumber: issueRuntime.currentPrNumber }
    : undefined;

  const closeRequested = completionRule.actions.includes(Action.CLOSE_ISSUE);
  const canonicalPrEvidenceUrl = prUrl
    ?? issueRuntime?.currentPrUrl
    ?? issueRuntime?.artifactOfRecord?.url
    ?? undefined;
  const hasEvidence = hasMeaningfulCompletionEvidence(effectiveSummary, canonicalPrEvidenceUrl, createdTasks);
  const hasArchetypeEvidence = hasArchetypeSpecificEvidence(deliverable, effectiveSummary, canonicalPrEvidenceUrl, createdTasks);
  const finalAcceptance = buildFinalAcceptanceSummary({
    deliverable,
    qualityPolicy,
    donePolicy,
    hasEvidence,
    closeRequested,
    qualityCriticality,
    riskProfile: issueRuntime?.riskProfile ?? [],
  });

  await auditLog(workspaceDir, "completion_policy_snapshot", {
    project: projectName,
    issue: issueId,
    role,
    deliverable,
    qualityGateChecks: qualityPolicy.requiredChecks,
    requiredEvidence: qualityPolicy.requiredEvidence,
    doneArtifacts: donePolicy.requiredArtifacts,
    doneEvidence: donePolicy.requiredEvidence,
    qualityCriticality,
    qualityCriticalityFloor: qualityPolicy.qualityCriticalityFloor,
    riskProfile: issueRuntime?.riskProfile ?? [],
    finalAcceptance,
  }).catch(() => {});

  await auditLog(workspaceDir, "final_acceptance_summary", {
    project: projectName,
    issue: issueId,
    role,
    ...finalAcceptance,
  }).catch(() => {});

  if (closeRequested && !hasEvidence) {
    await auditLog(workspaceDir, "completion_policy_block", {
      project: projectName,
      issue: issueId,
      role,
      result,
      reason: "missing_completion_evidence",
      deliverable,
      requiredEvidence: donePolicy.requiredEvidence,
    }).catch(() => {});
    throw new Error(
      `Refusing to complete issue #${issueId} without meaningful completion evidence for ${deliverable}. ` +
      `Provide a substantive summary, PR evidence, or created-task evidence before close.`,
    );
  }

  if (closeRequested && !hasArchetypeEvidence) {
    await auditLog(workspaceDir, "completion_policy_block", {
      project: projectName,
      issue: issueId,
      role,
      result,
      reason: "missing_archetype_specific_evidence",
      deliverable,
    }).catch(() => {});
    throw new Error(
      `Refusing to complete issue #${issueId} because the final summary lacks ${deliverable}-specific evidence. ` +
      `Describe the relevant ${deliverable} behavior more concretely or attach PR/task evidence.`,
    );
  }

  const shouldBlockMergeBeforeTest = (
    completionRule.actions.includes(Action.MERGE_PR) &&
    role === "reviewer" &&
    (workflow.testPolicy ?? TestPolicy.SKIP) === TestPolicy.AGENT
  );
  if (shouldBlockMergeBeforeTest) {
    completionRule = {
      ...completionRule,
      actions: completionRule.actions.filter((action) =>
        action !== Action.MERGE_PR &&
        action !== Action.GIT_PULL &&
        action !== Action.REOPEN_ISSUE
      ),
    };
    await auditLog(workspaceDir, "illegal_merge_before_test", {
      project: projectName,
      issue: issueId,
      role,
      from: completionRule.from,
      to: completionRule.to,
      result,
    }).catch(() => {});
  }

  // Execute pre-notification actions
  preActions: for (const action of completionRule.actions) {
    switch (action) {
      case Action.GIT_PULL:
        try { await rc(["git", "pull"], { timeoutMs: timeouts.gitPullMs, cwd: repoPath }); } catch (err) {
          auditLog(workspaceDir, "pipeline_warning", { step: "gitPull", issue: issueId, role, error: (err as Error).message ?? String(err) }).catch(() => {});
        }
        break;
      case Action.DETECT_PR:
        if (!prUrl) { try {
          // Try open PR first (developer just finished — MR is still open), fall back to merged
          const prStatus = await provider.getPrStatus(issueId, prSelector);
          if (prStatus.currentIssueMatch !== false) {
            prUrl = prStatus.url ?? await provider.getMergedMRUrl(issueId) ?? undefined;
            prTitle = prStatus.title;
            sourceBranch = prStatus.sourceBranch;
          }
        } catch (err) {
          auditLog(workspaceDir, "pipeline_warning", { step: "detectPr", issue: issueId, role, error: (err as Error).message ?? String(err) }).catch(() => {});
        } }
        break;
      case Action.MERGE_PR:
        try {
          // Grab PR metadata before merging (the MR is still open at this point)
          if (!prTitle) {
            try {
              const prStatus = await provider.getPrStatus(issueId, prSelector);
              if (prStatus.currentIssueMatch === false) {
                throw new Error(`Bound PR no longer targets issue #${issueId}`);
              }
              prUrl = prUrl ?? prStatus.url ?? undefined;
              prTitle = prStatus.title;
              sourceBranch = prStatus.sourceBranch;
            } catch { /* best-effort */ }
          }
          await withCorrelationContext({
            issueId,
            prNumber: issueRuntime?.currentPrNumber ?? undefined,
            headSha: issueRuntime?.lastHeadSha ?? undefined,
            phase: "pipeline-merge",
          }, () => withTelemetrySpan("fabrica.pipeline.merge", {
            issueId,
            prNumber: issueRuntime?.currentPrNumber ?? undefined,
            headSha: issueRuntime?.lastHeadSha ?? undefined,
            phase: "pipeline-merge",
          }, async () => provider.mergePr(issueId, prSelector)));
          mergedPr = true;
          mergedArtifactHeadSha = issueRuntime?.lastHeadSha ?? undefined;
          if (project && issueRuntime?.currentPrNumber) {
            await persistMergedArtifact({
              workspaceDir,
              projectSlug,
              issueId,
              issueRuntime,
              prUrl,
              headSha: mergedArtifactHeadSha,
            });
          }
        } catch (err) {
          const fromState = Object.values(workflow.states).find((state) => state.label === completionRule.from);
          const mergeFailedTransition = fromState?.on?.[WorkflowEvent.MERGE_FAILED];
          if (role === "tester" && effectiveResult === "pass" && mergeFailedTransition) {
            const targetKey = typeof mergeFailedTransition === "string"
              ? mergeFailedTransition
              : mergeFailedTransition.target;
            const targetState = workflow.states[targetKey];
            if (targetState) {
              const fallbackActions = typeof mergeFailedTransition === "object"
                ? (mergeFailedTransition.actions ?? [])
                : [];
              completionRule = {
                from: completionRule.from,
                to: targetState.label,
                actions: fallbackActions,
              };
              effectiveResult = "fail";
              effectiveSummary = `Merge failed after QA pass: ${(err as Error).message ?? String(err)}`;
              mergedPr = false;
              await auditLog(workspaceDir, "pipeline_merge_failed", {
                step: "mergePr",
                issue: issueId,
                role,
                originalResult: result,
                fallbackResult: effectiveResult,
                fallbackTarget: targetState.label,
                error: (err as Error).message ?? String(err),
              }).catch(() => {});
              break preActions;
            }
          }
          // MERGE_PR is a blocking action — no fallback transition means the completion
          // must abort. Proceeding without a successful merge would mark the issue done
          // without an actual merged PR. The issue stays in its current state (C4).
          await auditLog(workspaceDir, "pipeline_merge_failed_blocking", {
            step: "mergePr", issue: issueId, role,
            error: (err as Error).message ?? String(err),
          }).catch(() => {});
          throw err;
        }
        break;
    }
  }

  await assertIssueCanClose({
    workspaceDir,
    projectName,
    projectSlug,
    issueId,
    role,
    provider,
    selector: prSelector,
    issueRuntime,
    followUpPrRequired: issueRuntime?.followUpPrRequired === true,
    closeRequested: completionRule.actions.includes(Action.CLOSE_ISSUE),
  });

  // Get issue early (for URL in notification + channel routing)
  const issue = await provider.getIssue(issueId);
  const notifyTarget = resolveNotifyChannel(issue.labels, channels);

  // Get next state description from workflow
  const nextState = describeStateByLabel(workflow, completionRule.to) ?? getNextStateDescription(workflow, role, effectiveResult);

  // Retrieve worker name from project state (best-effort)
  let workerName: string | undefined;
  try {
    if (project && opts.level !== undefined && opts.slotIndex !== undefined) {
      const roleWorker = getRoleWorker(project, role);
      const slot = roleWorker.levels[opts.level]?.[opts.slotIndex];
      workerName = slot?.name;
    }
  } catch {
    // Best-effort — don't fail notification if name retrieval fails
  }

  const notifyConfig = getNotificationConfig(pluginConfig);
  // Transition label first (critical — if this fails, issue still has correct state)
  // Then execute post-transition actions (close/reopen)
  // Finally deactivate worker (last — ensures label is set even if deactivation fails)
  
  await provider.transitionLabel(issueId, completionRule.from as StateLabel, completionRule.to as StateLabel);

  const acceptanceSummary = buildHumanAcceptanceSummary(finalAcceptance);

  // Execute post-transition actions
  for (const action of completionRule.actions) {
    switch (action) {
      case Action.CLOSE_ISSUE:
        await guardedCloseIssue({
          workspaceDir,
          projectName,
          projectSlug,
          issueId,
          role,
          provider,
          selector: prSelector,
          issueRuntime,
          followUpPrRequired: issueRuntime?.followUpPrRequired === true,
        });
        // Notify that the issue has been fully completed and closed
        notify(
          {
            type: "issueComplete",
            project: projectName,
            issueId,
            issueUrl: issue.web_url,
            issueTitle: issue.title,
            prUrl,
            acceptanceSummary,
          },
          {
            workspaceDir,
            config: notifyConfig,
            channelId: notifyTarget?.channelId,
            channel: notifyTarget?.channel ?? "telegram",
            runtime,
            runCommand: rc,
            accountId: notifyTarget?.accountId,
            messageThreadId: notifyTarget?.messageThreadId,
          },
        ).catch((err) => {
          auditLog(workspaceDir, "pipeline_warning", { step: "issueCompleteNotify", issue: issueId, role, error: (err as Error).message ?? String(err) }).catch(() => {});
        });
        break;
      case Action.REOPEN_ISSUE:
        await provider.reopenIssue(issueId);
        await updateIssueRuntime(workspaceDir, projectSlug, issueId, {
          followUpPrRequired: true,
        }).catch(() => {});
        break;
    }
  }

  // Deactivate worker last (non-critical — session cleanup)
  if (issueRuntime?.parentIssueId) {
    const childDecompositionStatus = effectiveResult === "blocked" || effectiveResult === "refine" || effectiveResult === "fail_infra"
      ? "blocked"
      : effectiveResult === "fail" || effectiveResult === "reject"
        ? "active"
        : issueRuntime.decompositionStatus;
    if (childDecompositionStatus !== issueRuntime.decompositionStatus) {
      await updateIssueRuntime(workspaceDir, projectSlug, issueId, {
        decompositionStatus: childDecompositionStatus,
      }).catch(() => {});
    }
  }
  // Deactivate worker last (non-critical — session cleanup)
  if (issueRuntime?.parentIssueId) {
    const childDecompositionStatus = effectiveResult === "blocked" || effectiveResult === "refine" || effectiveResult === "fail_infra"
      ? "blocked"
      : effectiveResult === "fail" || effectiveResult === "reject"
        ? "active"
        : issueRuntime.decompositionStatus;
    if (childDecompositionStatus !== issueRuntime.decompositionStatus) {
      await updateIssueRuntime(workspaceDir, projectSlug, issueId, {
        decompositionStatus: childDecompositionStatus,
      }).catch(() => {});
    }
  }
  await deactivateWorker(workspaceDir, projectSlug, role, { level: opts.level, slotIndex: opts.slotIndex, issueId: String(issueId) });

  await reconcileParentLifecycleForIssue({
    workspaceDir,
    projectSlug,
    issueId,
    provider,
    workflow,
  }).catch(() => {});

  notify(
    {
      type: "workerComplete",
      project: projectName,
      issueId,
      issueUrl: issue.web_url,
      role,
      level: opts.level,
      name: workerName,
      result: effectiveResult as "done" | "pass" | "fail" | "refine" | "blocked",
      summary: effectiveSummary,
      acceptanceSummary,
      nextState,
      prUrl,
      createdTasks,
      dispatchCycleId: issueRuntime?.lastDispatchCycleId ?? null,
      dispatchRunId: issueRuntime?.dispatchRunId ?? null,
    },
    {
      workspaceDir,
      config: notifyConfig,
      channelId: notifyTarget?.channelId,
      channel: notifyTarget?.channel ?? "telegram",
      runtime,
      runCommand: rc,
      accountId: notifyTarget?.accountId,
      messageThreadId: notifyTarget?.messageThreadId,
    },
  ).catch((err) => {
    auditLog(workspaceDir, "pipeline_warning", { step: "notify", issue: issueId, role, error: (err as Error).message ?? String(err) }).catch(() => {});
  });

  if (mergedPr) {
    notify(
      {
        type: "prMerged",
        project: projectName,
        issueId,
        issueUrl: issue.web_url,
        issueTitle: issue.title,
        prUrl,
        prTitle,
        sourceBranch,
        mergedBy: "pipeline",
      },
      {
        workspaceDir,
        config: notifyConfig,
        channelId: notifyTarget?.channelId,
        channel: notifyTarget?.channel ?? "telegram",
        runtime,
        runCommand: rc,
        accountId: notifyTarget?.accountId,
        messageThreadId: notifyTarget?.messageThreadId,
      },
    ).catch((err) => {
      auditLog(workspaceDir, "pipeline_warning", { step: "mergeNotify", issue: issueId, role, error: (err as Error).message ?? String(err) }).catch(() => {});
    });
  }

  if (opts.overrideReason) {
    await auditLog(workspaceDir, "workflow_auto_recovery", {
      project: projectName,
      issue: issueId,
      role,
      result,
      overrideReason: opts.overrideReason,
      from: rule.to,
      to: completionRule.to,
    }).catch(() => {});
  }

  // Send review routing notification when developer completes
  if (role === "developer" && result === "done") {
    // Re-fetch issue to get labels after transition
    const updated = await provider.getIssue(issueId);
    const routing = detectStepRouting(updated.labels, "review") as "human" | "agent" | null;
    if (routing === "human" || routing === "agent") {
      notify(
        {
          type: "reviewNeeded",
          project: projectName,
          issueId,
          issueUrl: updated.web_url,
          issueTitle: updated.title,
          routing,
          prUrl,
          dispatchCycleId: issueRuntime?.lastDispatchCycleId ?? null,
          dispatchRunId: issueRuntime?.dispatchRunId ?? null,
        },
        {
          workspaceDir,
          config: notifyConfig,
          channelId: notifyTarget?.channelId,
          channel: notifyTarget?.channel ?? "telegram",
          runtime,
          runCommand: rc,
          accountId: notifyTarget?.accountId,
          messageThreadId: notifyTarget?.messageThreadId,
        },
      ).catch((err) => {
        auditLog(workspaceDir, "pipeline_warning", { step: "reviewNotify", issue: issueId, role, error: (err as Error).message ?? String(err) }).catch(() => {});
      });
    }
  }

  // Build announcement using workflow-derived emoji
  const emoji = getCompletionEmoji(role, effectiveResult);
  const label = `${role}:${effectiveResult}`.replace(":", " ").toUpperCase();
  let announcement = `${emoji} ${label} #${issueId}`;
  if (effectiveSummary) announcement += ` — ${effectiveSummary}`;
  announcement += `\n📋 [Issue #${issueId}](${issue.web_url})`;
  if (prUrl) announcement += `\n🔗 [PR](${prUrl})`;
  if (createdTasks && createdTasks.length > 0) {
    announcement += `\n📌 Created tasks:`;
    for (const t of createdTasks) {
      announcement += `\n  - [#${t.id}: ${t.title}](${t.url})`;
    }
  }
  announcement += `\n${nextState}.`;

  return {
    labelTransition: `${completionRule.from} → ${completionRule.to}`,
    announcement,
    nextState,
    prUrl,
    issueUrl: issue.web_url,
    issueClosed: completionRule.actions.includes(Action.CLOSE_ISSUE),
    issueReopened: completionRule.actions.includes(Action.REOPEN_ISSUE),
    finalAcceptance,
  };
}

function describeStateByLabel(workflow: WorkflowConfig, label: string): string | undefined {
  const state = Object.values(workflow.states).find((candidate) => candidate.label === label);
  if (!state) return undefined;
  if (state.type === "terminal") return "Done!";
  if (state.type === "hold") return "awaiting human decision";
  if (state.type === "queue" && state.role) {
    return `${state.role.toUpperCase()} queue`;
  }
  return state.label;
}

async function assertIssueCanClose(opts: {
  workspaceDir: string;
  projectName: string;
  projectSlug: string;
  issueId: number;
  role: string;
  provider: IssueProvider;
  selector?: PrSelector;
  issueRuntime?: {
    artifactOfRecord?: {
      prNumber: number;
      headSha?: string | null;
      mergedAt: string;
      url?: string | null;
    } | null;
    currentPrNumber?: number | null;
    currentPrUrl?: string | null;
    currentPrState?: string | null;
    lastHeadSha?: string | null;
    lastRunId?: string | null;
    lastCheckRunId?: number | null;
  };
  followUpPrRequired?: boolean;
  closeRequested: boolean;
}): Promise<void> {
  const {
    workspaceDir,
    projectName,
    projectSlug,
    issueId,
    role,
    provider,
    selector,
    issueRuntime,
    followUpPrRequired,
    closeRequested,
  } = opts;
  if (!closeRequested) return;

  const prStatus = await provider.getPrStatus(issueId, selector);
  const guard = evaluateIssueCloseGuard({
    prStatus,
    issueRuntime,
    followUpPrRequired,
  });
  if (guard.allowed) return;
  const currentPrNumber = guard.currentPrNumber ?? null;

  if (guard.reason === "missing_artifact_of_record") {
      await auditLog(workspaceDir, "pipeline_close_blocked_missing_artifact_of_record", {
        project: projectName,
        projectSlug,
        issue: issueId,
        role,
        prNumber: currentPrNumber,
        prUrl: prStatus.url ?? issueRuntime?.currentPrUrl ?? null,
        prState: prStatus.state ?? issueRuntime?.currentPrState ?? null,
      }).catch(() => {});
      throw new Error(
        `Refusing to close issue #${issueId} without a confirmed artifact of record for the current PR cycle.\n\n` +
        `Wait for the merge-confirming event or persist the merged PR artifact before closing the issue.`,
      );
  }
  if (guard.reason === "follow_up_pr_required") {
    await auditLog(workspaceDir, "pipeline_close_blocked_follow_up_pr_required", {
      project: projectName,
      projectSlug,
      issue: issueId,
      role,
      prNumber: currentPrNumber,
      prUrl: prStatus.url ?? issueRuntime?.currentPrUrl ?? null,
      prState: prStatus.state ?? issueRuntime?.currentPrState ?? null,
    }).catch(() => {});
    throw new Error(
      `Refusing to close issue #${issueId} while follow-up work still requires a canonical PR.\n\n` +
      `Open and bind a new PR for the current cycle before closing the issue.`,
    );
  }

  await auditLog(workspaceDir, "pipeline_close_blocked_open_pr", {
    project: projectName,
    projectSlug,
    issue: issueId,
    role,
    prNumber: currentPrNumber,
    prUrl: prStatus.url ?? issueRuntime?.currentPrUrl ?? null,
    prState: prStatus.state ?? issueRuntime?.currentPrState ?? null,
  }).catch(() => {});

  throw new Error(
    `Refusing to close issue #${issueId} while canonical PR #${currentPrNumber ?? "unknown"} is still open.\n\n` +
    `Update the workflow so the final gate merges the PR before closeIssue, or return the issue to follow-up instead of Done.`,
  );
}

export function evaluateIssueCloseGuard(opts: {
  prStatus: Pick<PrStatus, "number" | "state" | "url"> & { number?: number };
  issueRuntime?: CloseGuardIssueRuntime;
  followUpPrRequired?: boolean;
}): CloseGuardEvaluation {
  const { prStatus, issueRuntime, followUpPrRequired } = opts;
  const prStillOpen =
    !!prStatus.url &&
    prStatus.state !== PrState.MERGED &&
    prStatus.state !== PrState.CLOSED;
  const currentPrNumber = issueRuntime?.currentPrNumber ?? prStatus.number ?? null;
  const hadCanonicalPrCycle = Boolean(
    issueRuntime?.currentPrNumber ||
    issueRuntime?.currentPrUrl ||
    issueRuntime?.currentPrState ||
    issueRuntime?.lastHeadSha ||
    issueRuntime?.lastRunId ||
    issueRuntime?.lastCheckRunId ||
    issueRuntime?.artifactOfRecord,
  );

  if (!prStillOpen) {
    // If the live API confirms the PR is merged, that IS the artifact — allow close
    // even if issueRuntime.artifactOfRecord hasn't been persisted yet (race with webhook).
    const prConfirmedMerged = prStatus.state === PrState.MERGED;
    if (hadCanonicalPrCycle && !issueRuntime?.artifactOfRecord && !prConfirmedMerged) {
      return { allowed: false, reason: "missing_artifact_of_record", currentPrNumber };
    }
    if (followUpPrRequired) {
      return { allowed: false, reason: "follow_up_pr_required", currentPrNumber };
    }
    return { allowed: true, currentPrNumber };
  }

  return { allowed: false, reason: "open_pr", currentPrNumber };
}
