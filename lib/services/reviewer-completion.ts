import { log as auditLog } from "../audit.js";
import { loadConfig } from "../config/index.js";
import { createProvider } from "../providers/index.js";
import { deactivateWorker, readProjects } from "../projects/index.js";
import { resilientLabelTransition } from "../workflow/labels.js";
import { findStateByLabel, getActiveLabel, getRevertLabel, type WorkflowConfig, WorkflowEvent } from "../workflow/index.js";
import type { RunCommand } from "../context.js";
import { parseFabricaSessionKey } from "../dispatch/bootstrap-hook.js";
import {
  extractReviewerDecisionFromMessages,
  type ReviewerDecision,
  parseReviewerSessionResult,
} from "./reviewer-session.js";

export function resolveReviewerDecisionTransition(
  workflow: WorkflowConfig,
  decision: ReviewerDecision,
): { eventKey: "APPROVE" | "REJECT"; targetKey: string; targetLabel: string } | null {
  const activeLabel = getActiveLabel(workflow, "reviewer");
  const reviewingState = findStateByLabel(workflow, activeLabel);
  if (!reviewingState?.on) return null;

  const eventKey = decision === "approve" ? WorkflowEvent.APPROVE : WorkflowEvent.REJECT;
  const transition = reviewingState.on[eventKey];
  const targetKey = typeof transition === "string" ? transition : transition?.target;
  const targetState = targetKey ? workflow.states[targetKey] : undefined;
  if (!targetKey || !targetState) return null;

  return { eventKey, targetKey, targetLabel: targetState.label };
}

export async function handleReviewerAgentEnd(opts: {
  sessionKey: string;
  messages?: unknown[];
  runtime?: { subagent?: { getSessionMessages?: (opts: { sessionKey: string }) => Promise<unknown> } };
  workspaceDir?: string;
  runCommand?: RunCommand;
  fallbackToQueueOnUndetermined?: boolean;
}): Promise<ReviewerDecision | null> {
  const eventDecision = Array.isArray(opts.messages) && opts.messages.length > 0
    ? extractReviewerDecisionFromMessages(opts.messages)
    : null;
  const decision = eventDecision ?? (
    opts.runtime
      ? await parseReviewerSessionResult(opts.runtime, opts.sessionKey)
      : null
  );

  if (!opts.workspaceDir || !opts.runCommand) {
    return decision;
  }

  const parsed = parseFabricaSessionKey(opts.sessionKey);
  if (!parsed || parsed.role !== "reviewer") {
    return decision;
  }

  const projects = await readProjects(opts.workspaceDir);
  const projectEntry = Object.entries(projects.projects).find(([, project]) => project.name === parsed.projectName);
  if (!projectEntry) {
    return decision;
  }

  const [projectSlug, project] = projectEntry;
  const reviewerWorker = project.workers.reviewer;
  if (!reviewerWorker) {
    return decision;
  }

  let issueId: number | null = null;
  let slotRef: { level: string; slotIndex: number; active: boolean } | null = null;
  for (const [level, slots] of Object.entries(reviewerWorker.levels)) {
    const slotIndex = slots.findIndex((candidate) => candidate.sessionKey === opts.sessionKey);
    if (slotIndex >= 0) {
      const slot = slots[slotIndex]!;
      issueId = Number(slot.issueId ?? slot.lastIssueId ?? 0) || null;
      slotRef = { level, slotIndex, active: slot.active };
      break;
    }
  }
  if (!issueId) {
    return decision;
  }

  const { workflow } = await loadConfig(opts.workspaceDir, projectSlug);
  const activeLabel = getActiveLabel(workflow, "reviewer");
  const revertLabel = getRevertLabel(workflow, "reviewer");
  const { provider } = await createProvider({
    repo: project.repo,
    provider: project.provider,
    runCommand: opts.runCommand,
  });
  const issue = await provider.getIssue(issueId);
  const currentLabel = issue.labels.find((label) => label === activeLabel || label === revertLabel);

  if (!currentLabel) {
    return decision;
  }

  if (decision) {
    const transition = resolveReviewerDecisionTransition(workflow, decision);
    if (transition && transition.targetLabel !== currentLabel) {
      await resilientLabelTransition(provider, issueId, currentLabel, transition.targetLabel);
      if (slotRef?.active) {
        await deactivateWorker(opts.workspaceDir, projectSlug, "reviewer", {
          level: slotRef.level,
          slotIndex: slotRef.slotIndex,
        });
      }
      await auditLog(opts.workspaceDir, "reviewer_session_transition", {
        sessionKey: opts.sessionKey,
        project: parsed.projectName,
        issueId,
        result: decision,
        eventKey: transition.eventKey,
        from: currentLabel,
        to: transition.targetLabel,
      }).catch(() => {});
    }
    return decision;
  }

  if (opts.fallbackToQueueOnUndetermined && currentLabel === activeLabel) {
    await provider.transitionLabel(issueId, activeLabel, revertLabel);
    if (slotRef?.active) {
      await deactivateWorker(opts.workspaceDir, projectSlug, "reviewer", {
        level: slotRef.level,
        slotIndex: slotRef.slotIndex,
      });
    }
    await auditLog(opts.workspaceDir, "reviewer_session_no_result", {
      sessionKey: opts.sessionKey,
      project: parsed.projectName,
      issueId,
    }).catch(() => {});
  }

  return null;
}
