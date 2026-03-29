/**
 * diagnostic.ts — Diagnostic-first stall analysis.
 *
 * Examines evidence (PR state, commits, session activity) to determine
 * the correct action when a worker stalls. Does NOT modify any state.
 */
import { execFileSync } from "child_process";

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

  // Debug logging — remove after confirming diagnostic works
  console.log(`[diagnostic] diagnoseStall: owner=${owner} repo=${repo} issueId=${issueId} dispatchAttemptCount=${dispatchAttemptCount}`);

  // Repeated stall without artifacts → needs human
  if ((dispatchAttemptCount ?? 0) >= 2) {
    const hasArtifacts = await checkForArtifacts(owner, repo, issueId);
    if (!hasArtifacts) {
      return { action: "needs_human_review", reason: "stall", evidence: `${dispatchAttemptCount} attempts, zero artifacts` };
    }
  }

  // Check for PR
  const pr = await findPrForIssue(owner, repo, issueId);
  console.log(`[diagnostic] findPrForIssue result: ${JSON.stringify(pr)}`);
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

function ghSync(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8", timeout: 15_000 });
}

async function findPrForIssue(owner: string, repo: string, issueId: number): Promise<{ number: number } | null> {
  if (!owner || !repo) return null;
  try {
    const stdout = ghSync([
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
  if (!owner || !repo) return "pending";
  try {
    const stdout = ghSync([
      "pr", "view", String(prNumber), "--repo", `${owner}/${repo}`,
      "--json", "statusCheckRollup",
    ]);
    const data = JSON.parse(stdout);
    const checks: Array<{ conclusion: string; status: string }> = data.statusCheckRollup ?? [];
    if (checks.length === 0) return "pass"; // No checks configured = pass
    if (checks.every((c) => c.conclusion === "SUCCESS")) return "pass";
    if (checks.some((c) => c.conclusion === "FAILURE")) return "fail";
    return "pending";
  } catch {
    // If we can't check QA, default to pass — let the reviewer verify
    return "pass";
  }
}

async function checkForBranchCommits(owner: string, repo: string, issueId: number): Promise<boolean> {
  if (!owner || !repo) return false;
  try {
    const stdout = ghSync([
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
