import { StateType, type WorkflowConfig } from "../workflow/types.js";
import type { IssueRuntimeState } from "../projects/types.js";

export type ConvergenceCause =
  | "invalid_qa_evidence"
  | "qa_schema_missing"
  | "qa_section_count_invalid"
  | "qa_exit_code_missing"
  | "qa_exit_code_nonzero"
  | "qa_sanitization_failed"
  | "qa_missing_required_gates"
  | "qa_exit_codes_only"
  | "qa_coverage_below_threshold"
  | "qa_stale_or_unchanged"
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
  progressHeadSha: string | null;
};

export function classifyConvergenceCause(reason: string | null | undefined): ConvergenceCause {
  const text = String(reason ?? "").toLowerCase();
  if (!text) return "other";
  if (text.includes("qa_evidence_missing")) return "qa_schema_missing";
  if (text.includes("exactly one `## qa evidence` section") || text.includes("qa_section_count_invalid")) return "qa_section_count_invalid";
  if (text.includes("exit code: <number>") || text.includes("qa_exit_code_missing")) return "qa_exit_code_missing";
  if (text.includes("exit code must be 0") || text.includes("qa_exit_code_nonzero")) return "qa_exit_code_nonzero";
  if (text.includes("host-system paths") || text.includes("secrets or environment values") || text.includes("environment dump") || text.includes("qa_sanitization_failed")) return "qa_sanitization_failed";
  if (text.includes("qa_evidence_only_exit_codes") || text.includes("qa_exit_codes_only")) return "qa_exit_codes_only";
  if (text.includes("qa_coverage_below_threshold") || text.includes("coverage below threshold")) return "qa_coverage_below_threshold";
  if (text.includes("qa_stale_or_unchanged")) return "qa_stale_or_unchanged";
  if (text.includes("qa_gate_missing_") || text.includes("missing required gates")) return "qa_missing_required_gates";
  if (text.includes("invalid qa evidence")) return "invalid_qa_evidence";
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
    case "qa_schema_missing":
    case "qa_section_count_invalid":
    case "qa_exit_code_missing":
    case "qa_missing_required_gates":
      return 2;
    case "qa_exit_code_nonzero":
    case "qa_exit_codes_only":
    case "qa_coverage_below_threshold":
    case "qa_stale_or_unchanged":
    case "qa_sanitization_failed":
      return 1;
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
  const progressHeadSha = issueRuntime?.currentPrHeadSha ?? issueRuntime?.lastHeadSha ?? issueRuntime?.artifactOfRecord?.headSha ?? null;
  const previousCause = issueRuntime?.lastConvergenceCause ?? null;
  const previousCount = issueRuntime?.lastConvergenceRetryCount ?? 0;
  const previousHeadSha = issueRuntime?.lastConvergenceHeadSha ?? null;
  const sameHeadSha = !progressHeadSha || !previousHeadSha ? true : progressHeadSha === previousHeadSha;
  const retryCount = previousCause === cause && sameHeadSha ? previousCount + 1 : 1;
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
    progressHeadSha,
  };
}
