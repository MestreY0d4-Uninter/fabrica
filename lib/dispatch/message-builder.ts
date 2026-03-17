/**
 * message-builder.ts — Task message construction for worker sessions.
 */
import type { ResolvedRoleConfig } from "../config/index.js";
import { formatPrContext, formatPrFeedback, type PrContext, type PrFeedback } from "./pr-context.js";
import { getFallbackEmoji } from "../roles/index.js";

/**
 * Build the task message sent to a worker session.
 *
 * Role-specific instructions are NOT included in the message body.
 * They are passed as `extraSystemPrompt` in the gateway agent call,
 * which injects them into the worker's system prompt (see dispatch flow).
 */
export function buildTaskMessage(opts: {
  projectName: string;
  channelId: string;
  role: string;
  issueId: number;
  issueTitle: string;
  issueDescription: string;
  issueUrl: string;
  repo: string;
  baseBranch: string;
  comments?: Array<{ author: string; body: string; created_at: string }>;
  resolvedRole?: ResolvedRoleConfig;
  prContext?: PrContext;
  prFeedback?: PrFeedback;
  securityChecklist?: string;
  /** Pre-formatted attachment context string (from formatAttachmentsForTask) */
  attachmentContext?: string;
  /** True when the next developer cycle must create a fresh branch/PR for this issue. */
  followUpPrRequired?: boolean;
}): string {
  const sanitizeRepoContext = (value: string) =>
    value.startsWith("/") || value.startsWith("~/") ? "[repository workspace hidden]" : value;

  const {
    projectName, channelId, role, issueId, issueTitle,
    issueDescription, issueUrl, repo, baseBranch,
  } = opts;
  const repoDisplay = sanitizeRepoContext(repo);

  const results = opts.resolvedRole?.completionResults ?? [];
  const availableResults = results.map((r: string) => `"${r}"`).join(", ");

  const isFeedbackCycle = !!opts.prFeedback;

  const parts = [
    `${role.toUpperCase()} task for project "${projectName}" — Issue #${issueId}`,
    ``,
    issueTitle,
    issueDescription ? `\n${issueDescription}` : "",
  ];

  if (isFeedbackCycle) {
    parts.push(
      ``,
      `> **⚠️ FEEDBACK CYCLE — This issue is returning from review.**`,
      `> The original description above is for context only.`,
      `> Your job is to address the PR Review Feedback below.`,
      `> When feedback conflicts with the original description, follow the PR feedback.`,
    );
  }

  if (opts.followUpPrRequired) {
    parts.push(
      ``,
      `> **FOLLOW-UP PR REQUIRED**`,
      `> The previous PR is no longer a valid artifact for this issue.`,
      `> Continue the work on a new branch and open a new PR that explicitly targets this issue.`,
      `> Do not reuse a PR/branch that was retargeted to another issue.`,
    );
  }

  // Include comments if present
  if (opts.comments && opts.comments.length > 0) {
    parts.push(``, `## Issue Discussion`);
    // Limit to last 20 comments to avoid bloating context
    const recentComments = opts.comments.slice(-20);
    for (const comment of recentComments) {
      const date = new Date(comment.created_at).toLocaleString();
      parts.push(``, `**${comment.author}** (${date}):`, comment.body);
    }
  }

  if (opts.prContext) parts.push(...formatPrContext(opts.prContext));
  if (opts.prFeedback) {
    parts.push(...formatPrFeedback(opts.prFeedback, baseBranch));
    
    // Defensive warning if branch name is missing (shouldn't happen in practice)
    if (!opts.prFeedback.branchName && opts.prFeedback.reason === "merge_conflict") {
      parts.push(
        ``,
        `⚠️ **Branch name could not be determined automatically.**`,
        `Check the PR URL above to find the correct branch, then:`,
        `\`\`\`bash`,
        `gh pr view <PR-number> --json headRefName --jq .headRefName`,
        `\`\`\``,
      );
    }
  }
  if (opts.securityChecklist?.trim()) {
    const maxChecklistLen = 12_000;
    const checklist = opts.securityChecklist.length > maxChecklistLen
      ? opts.securityChecklist.slice(0, maxChecklistLen) + "\n... (security checklist truncated)"
      : opts.securityChecklist;
    parts.push(``, `## Security Checklist`, checklist);
  }
  if (opts.attachmentContext) parts.push(opts.attachmentContext);

  parts.push(
    ``,
    `Repo: ${repoDisplay} | Branch: ${baseBranch} | ${issueUrl}`,
    `Project: ${projectName} | Channel: ${channelId}`,
  );

  parts.push(
    ``, `---`, ``,
    `## MANDATORY: Task Completion`,
    ``,
    `When you finish this task, you MUST call \`work_finish\` with:`,
    `- \`role\`: "${role}"`,
    `- \`channelId\`: "${channelId}"`,
    `- \`result\`: ${availableResults}`,
    `- \`summary\`: brief description of what you did`,
    ``,
    `⚠️ You MUST call work_finish even if you encounter errors or cannot finish.`,
    `Use "blocked" with a summary explaining why you're stuck.`,
    `Never end your session without calling work_finish.`,
  );



  return parts.join("\n");
}

/**
 * Build a minimal conflict-fix message — no issue description, no comments.
 * Just the PR feedback (rebase instructions) and work_finish instructions.
 */
export function buildConflictFixMessage(opts: {
  projectName: string;
  channelId: string;
  role: string;
  issueId: number;
  issueTitle: string;
  issueUrl: string;
  repo: string;
  baseBranch: string;
  resolvedRole?: ResolvedRoleConfig;
  prFeedback: PrFeedback;
}): string {
  const sanitizeRepoContext = (value: string) =>
    value.startsWith("/") || value.startsWith("~/") ? "[repository workspace hidden]" : value;

  const {
    projectName, channelId, role, issueId, issueTitle,
    issueUrl, repo, baseBranch, prFeedback,
  } = opts;
  const repoDisplay = sanitizeRepoContext(repo);

  const results = opts.resolvedRole?.completionResults ?? [];
  const availableResults = results.map((r: string) => `"${r}"`).join(", ");

  const parts = [
    `${role.toUpperCase()} task for project "${projectName}" — Issue #${issueId}`,
    ``,
    `> **🔧 MERGE CONFLICT FIX — This is a focused conflict resolution task.**`,
    `> Rebase the PR branch onto \`${baseBranch}\`, resolve conflicts, and force-push.`,
    `> Do NOT re-implement the feature or make other changes.`,
  ];

  parts.push(...formatPrFeedback(prFeedback, baseBranch));

  parts.push(
    ``,
    `Repo: ${repoDisplay} | Branch: ${baseBranch} | ${issueUrl}`,
    `Project: ${projectName} | Channel: ${channelId}`,
  );

  parts.push(
    ``, `---`, ``,
    `## MANDATORY: Task Completion`,
    ``,
    `When you finish this task, you MUST call \`work_finish\` with:`,
    `- \`role\`: "${role}"`,
    `- \`channelId\`: "${channelId}"`,
    `- \`result\`: ${availableResults}`,
    `- \`summary\`: brief description of what you did`,
    ``,
    `⚠️ You MUST call work_finish even if you encounter errors or cannot finish.`,
    `Use "blocked" with a summary explaining why you're stuck.`,
    `Never end your session without calling work_finish.`,
  );

  return parts.join("\n");
}

export function buildAnnouncement(
  level: string, role: string, sessionAction: "spawn" | "send",
  issueId: number, issueTitle: string, issueUrl: string,
  resolvedRole?: ResolvedRoleConfig, botName?: string,
): string {
  const emoji = resolvedRole?.emoji[level] ?? getFallbackEmoji(role);
  const actionVerb = sessionAction === "spawn" ? "Spawning" : "Sending";
  const nameTag = botName ? ` ${botName}` : "";
  return `${emoji} ${actionVerb} ${role.toUpperCase()}${nameTag} (${level}) for #${issueId}: ${issueTitle}\n🔗 [Issue #${issueId}](${issueUrl})`;
}

/**
 * Build a human-friendly session label from project name, role, and level.
 * e.g. "my-project", "developer", "medior" → "My Project — Developer (Medior)"
 */
export function formatSessionLabelFull(projectName: string, role: string, level: string, botName?: string): string {
  const titleCase = (s: string) => s.replace(/(^|\s|-)\S/g, (c) => c.toUpperCase()).replace(/-/g, " ");
  const nameLabel = botName ? ` ${botName}` : "";
  return `${titleCase(projectName)} — ${titleCase(role)}${nameLabel} (${titleCase(level)})`;
}

export function formatSessionLabel(projectName: string, role: string, level: string, botName?: string): string {
  const fullLabel = formatSessionLabelFull(projectName, role, level, botName);
  const maxLen = 64;
  if (fullLabel.length <= maxLen) return fullLabel;
  const titleCase = (s: string) => s.replace(/(^|\s|-)\S/g, (c) => c.toUpperCase()).replace(/-/g, " ");
  const projectLabel = titleCase(projectName);
  const nameLabel = botName ? ` ${botName}` : "";
  const suffix = ` — ${titleCase(role)}${nameLabel} (${titleCase(level)})`;
  const availableProjectLen = maxLen - suffix.length;
  if (availableProjectLen <= 4) return fullLabel.slice(0, maxLen - 3).trimEnd() + "...";
  return `${projectLabel.slice(0, availableProjectLen - 3).trimEnd()}...${suffix}`;
}
