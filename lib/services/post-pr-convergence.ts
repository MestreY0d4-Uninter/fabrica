import { StateType, type WorkflowConfig } from "../workflow/types.js";
import type { IssueRuntimeState } from "../projects/types.js";

export type ConvergenceCause =
  | "invalid_qa_evidence"
  | "merge_conflict"
  | "stalled_with_artifact"
  | "stalled_without_artifact"
  | "invalid_execution_path"
  | "missing_result_line"
  | "missing_pr"
  | "stale_pr_target"
  | "new_pr_required"
  | "review_feedback"
  | "developer_validation_failed"
  | "other";

export type ConvergenceAction = "retry_feedback" | "escalate_human";

export type ConvergenceDecision = {
  cause: ConvergenceCause;
  action: ConvergenceAction;
  targetLabel: string;
  retryCount: number;
  maxRetries: number;
  hasArtifact: boolean;
};

export function classifyConvergenceCause(reason: string | null | undefined): ConvergenceCause {
  const text = String(reason ?? "").toLowerCase();
  if (!text) return "other";
  if (text.includes("qa_gate_missing_") || text.includes("invalid qa evidence")) return "invalid_qa_evidence";
  if (text.includes("merge conflict") || text.includes("pr_still_conflicting")) return "merge_conflict";
  if (text.includes("stalled_with_artifact")) return "stalled_with_artifact";
  if (text.includes("stalled_without_artifact")) return "stalled_without_artifact";
  if (text.includes("invalid_execution_path")) return "invalid_execution_path";
  if (text.includes("missing_result_line")) return "missing_result_line";
  if (text.includes("missing_pr")) return "missing_pr";
  if (text.includes("no longer targets issue") || text.includes("stale_pr_target")) return "stale_pr_target";
  if (text.includes("new_pr_required")) return "new_pr_required";
  if (text.includes("changes requested") || text.includes("review_feedback")) return "review_feedback";
  if (text.includes("developer_validation_failed")) return "developer_validation_failed";
  return "other";
}

export function hasReviewableArtifact(issueRuntime?: IssueRuntimeState | null): boolean {
  return Boolean(
    issueRuntime?.currentPrUrl ||
    issueRuntime?.currentPrNumber ||
    issueRuntime?.artifactOfRecord?.prNumber,
  );
}

export function getConvergenceRetryBudget(cause: ConvergenceCause): number {
  switch (cause) {
    case "invalid_qa_evidence":
      return 2;
    case "merge_conflict":
    case "stalled_with_artifact":
    case "stale_pr_target":
    case "new_pr_required":
      return 1;
    case "invalid_execution_path":
    case "missing_result_line":
    case "stalled_without_artifact":
    case "missing_pr":
    case "review_feedback":
    case "developer_validation_failed":
    case "other":
    default:
      return 2;
  }
}

export function getPreferredHoldLabel(workflow: WorkflowConfig): string | null {
  const holds = Object.values(workflow.states).filter((state) => state.type === StateType.HOLD);
  if (holds.length === 0) return null;
  return holds.find((state) => state.label === "Refining")?.label ?? holds[0]?.label ?? null;
}

export function decidePostPrConvergence(params: {
  workflow: WorkflowConfig;
  issueRuntime?: IssueRuntimeState | null;
  reason: string | null | undefined;
  feedbackQueueLabel: string;
}): ConvergenceDecision {
  const { workflow, issueRuntime, reason, feedbackQueueLabel } = params;
  const cause = classifyConvergenceCause(reason);
  const hasArtifact = hasReviewableArtifact(issueRuntime);
  const previousCause = issueRuntime?.lastConvergenceCause ?? null;
  const previousCount = issueRuntime?.lastConvergenceRetryCount ?? 0;
  const retryCount = previousCause === cause ? previousCount + 1 : 1;
  const maxRetries = getConvergenceRetryBudget(cause);
  const holdLabel = getPreferredHoldLabel(workflow);
  const shouldEscalate = hasArtifact && retryCount > maxRetries && Boolean(holdLabel);

  return {
    cause,
    action: shouldEscalate ? "escalate_human" : "retry_feedback",
    targetLabel: shouldEscalate ? (holdLabel ?? feedbackQueueLabel) : feedbackQueueLabel,
    retryCount,
    maxRetries,
    hasArtifact,
  };
}
