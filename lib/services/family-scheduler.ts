import type { Project } from "../projects/types.js";
import {
  getDependencyIssueRuntimes,
  getIssueRuntime,
  getParentIssueRuntime,
  isChildIssue,
  isIssueExecutionComplete,
  isParentIssue,
} from "../projects/index.js";
import type { Role } from "../workflow/index.js";

function countActiveSiblingChildren(project: Project, parentIssueId: number, currentIssueId: number): number {
  const activeIssueIds = new Set<number>();
  for (const roleWorker of Object.values(project.workers ?? {})) {
    for (const slots of Object.values(roleWorker.levels ?? {})) {
      for (const slot of slots) {
        if (!slot.active || !slot.issueId) continue;
        const activeIssueId = Number(slot.issueId);
        if (!Number.isFinite(activeIssueId) || activeIssueId === currentIssueId) continue;
        activeIssueIds.add(activeIssueId);
      }
    }
  }
  return [...activeIssueIds].filter((issueId) => getIssueRuntime(project, issueId)?.parentIssueId === parentIssueId).length;
}

export function getFamilyDispatchBlockReason(
  project: Project,
  issueId: number,
  role: Role,
): string | null {
  const runtime = getIssueRuntime(project, issueId);

  if (isParentIssue(project, issueId)) {
    return role === "developer"
      ? "family_parent_coordinator_only"
      : "family_parent_not_executable";
  }

  if (isChildIssue(project, issueId)) {
    const parentRuntime = getParentIssueRuntime(project, issueId);
    if (parentRuntime?.decompositionStatus === "draft") return "family_parent_decomposition_draft";
    if (parentRuntime?.decompositionStatus === "blocked") return "family_parent_blocked";
    if (parentRuntime?.decompositionStatus === "completed") return "family_parent_completed";
    if (!runtime?.parentIssueId) return "family_child_missing_parent_binding";
    const maxParallelChildren = parentRuntime?.maxParallelChildren ?? null;
    if (maxParallelChildren && maxParallelChildren > 0) {
      const activeSiblingChildren = countActiveSiblingChildren(project, runtime.parentIssueId, issueId);
      if (activeSiblingChildren >= maxParallelChildren) return `family_parallel_limit_reached:${maxParallelChildren}`;
    }
    const incompleteDependencies = getDependencyIssueRuntimes(project, issueId)
      .filter((dependency) => !isIssueExecutionComplete(project, dependency.issueId))
      .map((dependency) => dependency.issueId);
    if (incompleteDependencies.length > 0) return `family_child_dependencies_pending:${incompleteDependencies.join(",")}`;
  }

  return null;
}
