/**
 * pr-context.ts — PR context fetching for dispatch.
 *
 * Extracts PR-related data gathering from the dispatch flow.
 * Two use cases:
 *   1. PR feedback for re-dispatch (issue returning from review with changes requested)
 *   2. PR context for reviewer role (URL + diff for code review)
 */
import type { IssueProvider, PrSelector } from "../providers/provider.js";
import { PrState } from "../providers/provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PrFeedback = {
  url: string;
  /** Source branch name (e.g. "feature/484-explicit-branch-name"). */
  branchName?: string;
  reason?: "changes_requested" | "merge_conflict" | "rejected";
  comments: Array<{ id: number; author: string; body: string; state: string; path?: string; line?: number }>;
};

export type PrContext = {
  url: string;
  diff?: string;
  /** PR description body (markdown). Includes QA Evidence, Summary, etc. */
  body?: string;
  /** Source branch name for the PR (e.g. "feature/1-json-yaml-cli"). */
  sourceBranch?: string;
};

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Fetch PR review feedback for an issue returning from review.
 * Returns undefined if no PR or no review comments found.
 * Best-effort: swallows errors (caller can still work from issue context).
 *
 * Includes explicit branch name in feedback to prevent developers from working
 * on the wrong PR when multiple PRs exist for the same issue (#482).
 */
export async function fetchPrFeedback(
  provider: IssueProvider,
  issueId: number,
  selector?: PrSelector,
): Promise<PrFeedback | undefined> {
  try {
    const prStatus = await provider.getPrStatus(issueId, selector);
    if (!prStatus.url || prStatus.state === PrState.MERGED || prStatus.state === PrState.CLOSED || prStatus.currentIssueMatch === false) {
      return undefined;
    }
    const reviewComments = await provider.getPrReviewComments(issueId, selector);
    if (reviewComments.length === 0) return undefined;

    const reason = prStatus.mergeable === false ? "merge_conflict" as const
      : (prStatus.state === PrState.CHANGES_REQUESTED || prStatus.state === PrState.HAS_COMMENTS) ? "changes_requested" as const
      : "rejected" as const;

    return {
      url: prStatus.url,
      branchName: prStatus.sourceBranch,
      reason,
      comments: reviewComments.map((c) => ({
        id: c.id, author: c.author, body: c.body, state: c.state,
        path: c.path, line: c.line,
      })),
    };
  } catch {
    return undefined;
  }
}

/**
 * Fetch PR context (URL + diff) for code review.
 * Returns undefined if no PR found.
 * Best-effort: swallows errors (caller can still work from issue context).
 */
export async function fetchPrContext(
  provider: IssueProvider,
  issueId: number,
  selector?: PrSelector,
): Promise<PrContext | undefined> {
  try {
    const prStatus = await provider.getPrStatus(issueId, selector);
    if (!prStatus.url || prStatus.state === PrState.MERGED || prStatus.state === PrState.CLOSED || prStatus.currentIssueMatch === false) {
      return undefined;
    }
    const diff = await provider.getPrDiff(issueId, selector) ?? undefined;
    return { url: prStatus.url, diff, body: prStatus.body, sourceBranch: prStatus.sourceBranch };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

/**
 * Format PR context section for task message.
 */
export function formatPrContext(prContext: PrContext): string[] {
  const parts: string[] = [``, `## Pull Request`, `🔗 ${prContext.url}`];
  if (prContext.sourceBranch) {
    parts.push(
      ``,
      `**⚠️ IMPORTANT: Test on the PR branch, not the base branch.**`,
      `\`\`\`bash`,
      `git fetch origin ${prContext.sourceBranch}`,
      `git checkout ${prContext.sourceBranch}`,
      `\`\`\``,
    );
  }
  if (prContext.body) {
    const maxBodyLen = 10_000;
    const body = prContext.body.length > maxBodyLen
      ? prContext.body.slice(0, maxBodyLen) + "\n... (body truncated)"
      : prContext.body;
    parts.push(``, `### PR Description`, body);
  }
  if (prContext.diff) {
    const maxDiffLen = 50_000;
    const diff = prContext.diff.length > maxDiffLen
      ? prContext.diff.slice(0, maxDiffLen) + "\n... (diff truncated, see PR for full changes)"
      : prContext.diff;
    parts.push(``, `### Diff`, "```diff", diff, "```");
  }
  return parts;
}

/**
 * Format PR review feedback section for task message.
 */
export function formatPrFeedback(prFeedback: PrFeedback, baseBranch: string): string[] {
  if (prFeedback.comments.length === 0) return [];

  const reasonLabel = prFeedback.reason === "merge_conflict"
    ? "⚠️ Merge conflicts detected"
    : prFeedback.reason === "changes_requested"
      ? "⚠️ Changes were requested"
      : "⚠️ PR was rejected";

  const parts: string[] = [
    ``, `## PR Review Feedback`,
    `${reasonLabel}. Address the feedback below.`,
    `🔗 ${prFeedback.url}`,
  ];

  for (const c of prFeedback.comments) {
    const location = c.path ? ` (${c.path}${c.line ? `:${c.line}` : ""})` : "";
    parts.push(``, `**${c.author}** [${c.state}]${location}:`, c.body);
  }

  if (prFeedback.reason === "merge_conflict") {
    const branchName = prFeedback.branchName || "your-branch";

    parts.push(
      ``, `### Conflict Resolution Instructions`,
      ``,
      `**Important:** You must update the EXISTING PR branch, not create a new one.`,
      ``,
      `🔹 PR: ${prFeedback.url}`,
      `🔹 Branch: \`${branchName}\``,
      ``,
      `**Step-by-step:**`,
      ``,
      `1. Fetch and check out the PR branch:`,
      `   \`\`\`bash`,
      `   git fetch origin ${branchName}`,
      `   git checkout ${branchName}`,
      `   # Or if you already have a worktree:`,
      `   cd "${branchName}"`,
      `   git fetch origin`,
      `   git reset --hard origin/${branchName}`,
      `   \`\`\``,
      ``,
      `2. Rebase onto \`${baseBranch}\`:`,
      `   \`\`\`bash`,
      `   git rebase ${baseBranch}`,
      `   \`\`\``,
      ``,
      `3. Resolve any conflicts:`,
      `   - Edit conflicted files (marked with <<<<<<< and >>>>>>>)`,
      `   - \`git add <resolved-files>\``,
      `   - \`git rebase --continue\``,
      `   - Repeat until rebase completes`,
      ``,
      `4. Force-push to the SAME branch:`,
      `   \`\`\`bash`,
      `   git push --force-with-lease origin ${branchName}`,
      `   \`\`\``,
      ``,
      `5. Verify the PR shows as mergeable:`,
      `   \`\`\`bash`,
      `   gh pr view <PR-number>`,
      `   # Status should be "Mergeable" or "Open"`,
      `   \`\`\``,
      ``,
      `⚠️ Do NOT create a new PR. Do NOT switch branches. Update THIS PR only.`,
    );
  }

  return parts;
}
