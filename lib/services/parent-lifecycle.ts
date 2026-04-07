import type { IssueProvider } from "../providers/provider.js";
import {
  getChildIssueRuntimes,
  getIssueRuntime,
  getParentIssueRuntime,
  isChildIssue,
  isIssueExecutionComplete,
  loadProjectBySlug,
  updateIssueRuntime,
} from "../projects/index.js";
import type { IssueRuntimeState } from "../projects/types.js";
import type { WorkflowConfig } from "../workflow/index.js";

function getTerminalLabel(workflow: WorkflowConfig): string | null {
  return Object.values(workflow.states).find((state) => state.type === "terminal")?.label ?? null;
}

function getCurrentWorkflowLabel(issueLabels: string[], workflow: WorkflowConfig): string | null {
  const labels = new Set(issueLabels);
  return Object.values(workflow.states).find((state) => labels.has(state.label))?.label ?? null;
}

function sameIds(a?: number[], b?: number[]): boolean {
  const left = [...(a ?? [])].sort((x, y) => x - y);
  const right = [...(b ?? [])].sort((x, y) => x - y);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolveChildRollupState(runtime: IssueRuntimeState | undefined): string {
  if (!runtime) return "pending_without_runtime";
  if (runtime.decompositionStatus === "blocked") return "blocked";
  if (runtime.artifactOfRecord?.mergedAt) return "completed_via_artifact";
  if (runtime.sessionCompletedAt) return "completed_via_session";
  if (runtime.currentPrUrl && runtime.currentPrState && runtime.currentPrState !== "merged" && runtime.currentPrState !== "closed") {
    return "pending_with_open_pr";
  }
  if (runtime.currentPrUrl) return "pending_with_pr";
  return "pending_without_pr";
}

function formatChildRollupLine(child: { issueId: number; runtime: IssueRuntimeState | undefined }): string {
  const runtime = child.runtime;
  const state = resolveChildRollupState(runtime);
  const prUrl = runtime?.artifactOfRecord?.url ?? runtime?.currentPrUrl ?? null;
  const mergedAt = runtime?.artifactOfRecord?.mergedAt ?? null;
  const headSha = runtime?.artifactOfRecord?.headSha ?? runtime?.lastHeadSha ?? null;
  const extras = [
    prUrl ? `PR: ${prUrl}` : null,
    mergedAt ? `mergedAt: ${mergedAt}` : null,
    headSha ? `headSha: ${headSha}` : null,
  ].filter(Boolean);
  return `- #${child.issueId} — ${state}${extras.length > 0 ? ` — ${extras.join(" — ")}` : ""}`;
}

const PARENT_ROLLUP_START = "<!-- fabrica:parent-rollup:start -->";
const PARENT_ROLLUP_END = "<!-- fabrica:parent-rollup:end -->";

function buildParentRollupComment(status: NonNullable<IssueRuntimeState["decompositionStatus"]>, completedChildIds: number[], blockedChildIds: number[], children: Array<{ issueId: number; runtime: IssueRuntimeState | undefined }>): string {
  const allChildIds = children.map((child) => child.issueId);
  const pendingChildIds = allChildIds.filter((id) => !completedChildIds.includes(id) && !blockedChildIds.includes(id));
  return [
    "## Parent Rollup",
    `- Status: ${status}`,
    `- Completed children (${completedChildIds.length}/${allChildIds.length}): ${completedChildIds.length > 0 ? completedChildIds.map((id) => `#${id}`).join(", ") : "none"}`,
    `- Pending children: ${pendingChildIds.length > 0 ? pendingChildIds.map((id) => `#${id}`).join(", ") : "none"}`,
    `- Blocked children: ${blockedChildIds.length > 0 ? blockedChildIds.map((id) => `#${id}`).join(", ") : "none"}`,
    "",
    "### Child Status",
    ...children.map((child) => formatChildRollupLine(child)),
  ].join("\n");
}

function upsertParentRollupBlock(body: string | undefined, rollup: string): string {
  const current = body ?? "";
  const block = `${PARENT_ROLLUP_START}\n${rollup}\n${PARENT_ROLLUP_END}`;
  const pattern = new RegExp(`${PARENT_ROLLUP_START}[\\s\\S]*?${PARENT_ROLLUP_END}`, "m");
  if (pattern.test(current)) {
    return current.replace(pattern, block);
  }
  return `${current.trimEnd()}${current.trim().length > 0 ? "\n\n" : ""}${block}`;
}

export async function reconcileParentLifecycleForIssue(opts: {
  workspaceDir: string;
  projectSlug: string;
  issueId: number;
  provider: IssueProvider;
  workflow: WorkflowConfig;
}): Promise<void> {
  const project = await loadProjectBySlug(opts.workspaceDir, opts.projectSlug);
  if (!project || !isChildIssue(project, opts.issueId)) return;

  const childRuntime = getIssueRuntime(project, opts.issueId);
  const parentRuntime = getParentIssueRuntime(project, opts.issueId);
  const parentIssueId = childRuntime?.parentIssueId;
  if (!parentIssueId || !parentRuntime) return;

  const children = getChildIssueRuntimes(project, parentIssueId);
  if (children.length === 0) return;

  const completedChildIds = children.filter((child) => isIssueExecutionComplete(project, child.issueId)).map((child) => child.issueId);
  const blockedChildIds = children.filter((child) => child.runtime?.decompositionStatus === "blocked").map((child) => child.issueId);
  const hasBlockedChild = blockedChildIds.length > 0;
  const allChildrenComplete = completedChildIds.length === children.length;
  const targetStatus = allChildrenComplete ? "completed" : (hasBlockedChild ? "blocked" : "active");
  const statusChanged = parentRuntime.decompositionStatus !== targetStatus;
  const completedChanged = !sameIds(parentRuntime.completedChildIssueIds, completedChildIds);
  const blockedChanged = !sameIds(parentRuntime.blockedChildIssueIds, blockedChildIds);
  const shouldUpdateRuntime = statusChanged || completedChanged || blockedChanged;
  const shouldCommentRollup = statusChanged || blockedChanged;

  if (shouldUpdateRuntime) {
    await updateIssueRuntime(opts.workspaceDir, opts.projectSlug, parentIssueId, {
      decompositionStatus: targetStatus,
      completedChildIssueIds: completedChildIds,
      blockedChildIssueIds: blockedChildIds,
      lastParentRollupAt: new Date().toISOString(),
    }).catch(() => {});
  }

  const parentIssue = await opts.provider.getIssue(parentIssueId).catch(() => null);
  if (!parentIssue) return;

  const rollup = buildParentRollupComment(targetStatus, completedChildIds, blockedChildIds, children);
  if (shouldUpdateRuntime) {
    await opts.provider.editIssue(parentIssueId, {
      body: upsertParentRollupBlock(parentIssue.description, rollup),
    }).catch(() => {});
    if (shouldCommentRollup) {
      await opts.provider.addComment(parentIssueId, rollup).catch(() => {});
    }
  }

  if (!allChildrenComplete) return;


  const terminalLabel = getTerminalLabel(opts.workflow);
  const currentLabel = getCurrentWorkflowLabel(parentIssue.labels, opts.workflow);
  if (terminalLabel && currentLabel && currentLabel !== terminalLabel && !parentIssue.labels.includes(terminalLabel)) {
    await opts.provider.transitionLabel(parentIssueId, currentLabel as any, terminalLabel as any).catch(() => {});
  }

  await opts.provider.addComment(parentIssueId, [
    "✅ Parent coordination complete.",
    "",
    "All child issues in this decomposition family have completed execution.",
    ...children.map((child) => formatChildRollupLine(child)),
  ].join("\n")).catch(() => {});
}
