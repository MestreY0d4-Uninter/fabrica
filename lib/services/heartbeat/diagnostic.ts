/**
 * diagnostic.ts — Diagnostic-first stall analysis.
 *
 * Examines evidence (PR state, commits, session activity) to determine
 * the correct action when a worker stalls. Does NOT modify any state.
 */

export type StallAction =
  | "transition_to_review"
  | "redispatch_same_level"
  | "nudge_open_pr"
  | "log_infra"
  | "escalate_level"
  | "retry_infra"
  | "needs_human_review";

export type StallReason = "stall" | "infra" | "complexity";

export interface StallDiagnosticInput {
  projectSlug: string;
  owner: string;
  repo: string;
  issueId: number;
  sessionKey: string;
  slotStartTime: number;
  sessionUpdatedAt: number;
  dispatchAttemptCount?: number;
}

export interface StallDiagnostic {
  action: StallAction;
  reason: StallReason;
  evidence: string;
  /** PR number found during diagnostic (if any), used for auto-binding. */
  prNumber?: number;
}

export async function diagnoseStall(input: StallDiagnosticInput): Promise<StallDiagnostic> {
  const { owner, repo, issueId, dispatchAttemptCount } = input;

  // Repeated stall without artifacts → needs human
  if ((dispatchAttemptCount ?? 0) >= 2) {
    const hasArtifacts = await checkForArtifacts(owner, repo, issueId);
    if (!hasArtifacts) {
      return { action: "needs_human_review", reason: "stall", evidence: `${dispatchAttemptCount} attempts, zero artifacts` };
    }
  }

  // Check for PR
  const pr = await findPrForIssue(owner, repo, issueId);
  if (pr) {
    const qaStatus = await checkPrQaStatus(owner, repo, pr.number);
    if (qaStatus === "pass") {
      return { action: "transition_to_review", reason: "stall", evidence: `PR #${pr.number} exists, QA passing`, prNumber: pr.number };
    }
    return { action: "redispatch_same_level", reason: "stall", evidence: `PR #${pr.number} exists, QA ${qaStatus}`, prNumber: pr.number };
  }

  // Check for commits on branch
  const hasCommits = await checkForBranchCommits(owner, repo, issueId);
  if (hasCommits) {
    return { action: "nudge_open_pr", reason: "stall", evidence: "Branch has commits but no PR" };
  }

  // No artifacts at all — check session activity
  const sessionAge = Date.now() - input.sessionUpdatedAt;
  const isSessionDead = sessionAge > 30 * 60_000; // 30 min idle

  if (isSessionDead) {
    return { action: "log_infra", reason: "infra", evidence: "Session dead, zero artifacts" };
  }

  // Session active but no commits → complexity issue
  return { action: "escalate_level", reason: "complexity", evidence: "Active session without commits" };
}

async function findPrForIssue(owner: string, repo: string, issueId: number): Promise<{ number: number } | null> {
  try {
    const { execa } = await import("execa");
    const { stdout } = await execa("gh", [
      "pr", "list", "--repo", `${owner}/${repo}`,
      "--search", `${issueId}`, "--json", "number", "--limit", "1",
    ]);
    const prs = JSON.parse(stdout);
    return prs.length > 0 ? prs[0] : null;
  } catch {
    return null;
  }
}

async function checkPrQaStatus(owner: string, repo: string, prNumber: number): Promise<"pass" | "fail" | "pending"> {
  try {
    const { execa } = await import("execa");
    const { stdout } = await execa("gh", [
      "pr", "checks", String(prNumber), "--repo", `${owner}/${repo}`, "--json", "state",
    ]);
    const checks = JSON.parse(stdout);
    if (checks.every((c: any) => c.state === "SUCCESS")) return "pass";
    if (checks.some((c: any) => c.state === "FAILURE")) return "fail";
    return "pending";
  } catch {
    return "pending";
  }
}

async function checkForBranchCommits(owner: string, repo: string, issueId: number): Promise<boolean> {
  try {
    const { execa } = await import("execa");
    const { stdout } = await execa("gh", [
      "api", `repos/${owner}/${repo}/commits`,
      "--jq", ".[0].sha",
      "-f", `sha=issue-${issueId}`,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function checkForArtifacts(owner: string, repo: string, issueId: number): Promise<boolean> {
  const pr = await findPrForIssue(owner, repo, issueId);
  if (pr) return true;
  return checkForBranchCommits(owner, repo, issueId);
}
