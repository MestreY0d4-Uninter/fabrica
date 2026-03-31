/**
 * task_comment — Add comments or notes to an issue.
 *
 * Use cases:
 * - Tester worker adds issue-side notes without blocking pass/fail
 * - Developer worker posts implementation notes
 * - Orchestrator adds summary comments
 *
 * Reviewer worker findings must stay in the review response and end with
 * the canonical `Review result:` line.
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { PluginContext } from "../../context.js";
import type { ToolContext } from "../../types.js";
import { log as auditLog } from "../../audit.js";
import { requireWorkspaceDir, resolveProjectFromContext, resolveProvider, autoAssignOwnerLabel, applyNotifyLabel } from "../helpers.js";
import { getAllRoleIds, getFallbackEmoji } from "../../roles/index.js";
import { getRoleWorker, recordIssueLifecycleBySessionKey } from "../../projects/index.js";
import { findPublicOutputViolations, sanitizePublicOutput } from "./public-output-sanitizer.js";

/** Valid author roles for attribution — all registry roles + orchestrator */
const AUTHOR_ROLES = [...getAllRoleIds(), "orchestrator"];
type AuthorRole = string;

export function createTaskCommentTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "task_comment",
    label: "Task Comment",
    description: `Add a comment to an issue. Use this for implementation notes or issue discussion that doesn't require a state change.

Use cases:
- Tester adds issue-side notes without blocking pass/fail
- Developer posts implementation notes or progress updates
- Orchestrator adds summary comments
- Cross-referencing related issues or PRs

Reviewer worker decisions belong in the review response, not in \`task_comment\`.

Examples:
- Simple: { issueId: 42, body: "Found an edge case with null inputs" }
- With role: { issueId: 42, body: "LGTM!", authorRole: "tester" }
- Detailed: { issueId: 42, body: "## Notes\\n\\n- Tested on staging\\n- All checks passing", authorRole: "developer" }`,
    parameters: {
      type: "object",
      required: ["channelId", "issueId", "body"],
      properties: {
        channelId: {
          type: "string",
          description: "YOUR chat/group ID — the numeric ID of the chat you are in right now (e.g. '-1003844794417'). Do NOT guess; use the ID of the conversation this message came from.",
        },
        issueId: {
          type: "number",
          description: "Issue ID to comment on",
        },
        body: {
          type: "string",
          description: "Comment body in markdown. Supports GitHub-flavored markdown.",
        },
        authorRole: {
          type: "string",
          enum: AUTHOR_ROLES,
          description: `Optional role attribution for the comment. One of: ${AUTHOR_ROLES.join(", ")}`,
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const issueId = params.issueId as number;
      const body = params.body as string;
      const authorRole = (params.authorRole as AuthorRole) ?? undefined;
      const workspaceDir = requireWorkspaceDir(toolCtx);

      await recordIssueLifecycleBySessionKey({
        workspaceDir,
        sessionKey: toolCtx.sessionKey,
        stage: "first_worker_activity",
        details: { source: "task_comment" },
      }).catch(() => {});

      if (!body || body.trim().length === 0) {
        throw new Error("Comment body cannot be empty.");
      }
      const violations = findPublicOutputViolations(body);
      if (violations.length > 0) {
        throw new Error(
          `Comment body contains unsanitized public output (${violations.join(", ")}). Summarize the result and redact paths, secrets, and environment dumps before posting.`,
        );
      }

      const { project, route } = await resolveProjectFromContext(workspaceDir, toolCtx, params.channelId as string | undefined);

      if (toolCtx.sessionKey && isReviewerSession(project, toolCtx.sessionKey)) {
        await auditLog(workspaceDir, "task_comment_blocked", {
          project: project.name,
          issueId,
          reason: "reviewer_session",
          sessionKey: toolCtx.sessionKey,
        });
        throw new Error(
          "Reviewer workers must keep findings in the review response and finish with " +
          "`Review result: APPROVE` or `Review result: REJECT`. " +
          "task_comment is reserved for issue-side operational notes from non-reviewer roles.",
        );
      }

      const { provider, type: providerType } = await resolveProvider(project, ctx.runCommand);

      if (authorRole === "reviewer" || isReviewerSession(project, toolCtx.sessionKey)) {
        await auditLog(workspaceDir, "task_comment_blocked", {
          project: project.name,
          issueId,
          reason: "reviewer_author_role",
          sessionKey: toolCtx.sessionKey ?? null,
        });
        throw new Error(
          "Reviewer worker findings must stay in the review response. task_comment is not allowed for reviewer findings.",
        );
      }

      const issue = await provider.getIssue(issueId);

      const sanitizedBody = sanitizePublicOutput(body);
      const commentBody = authorRole
        ? `${getRoleEmoji(authorRole)} **${authorRole.toUpperCase()}**: ${sanitizedBody}`
        : sanitizedBody;

      const commentId = await provider.addComment(issueId, commentBody);

      // Mark as system-managed (best-effort).
      provider.reactToIssueComment(issueId, commentId, "eyes").catch(() => {});

      // Apply notify label for channel routing (best-effort).
      applyNotifyLabel(provider, issueId, project, route.channelId, issue.labels, route.messageThreadId ?? undefined);

      // Auto-assign owner label to this instance (best-effort).
      autoAssignOwnerLabel(workspaceDir, provider, issueId, project).catch(() => {});

      await auditLog(workspaceDir, "task_comment", {
        project: project.name, issueId,
        authorRole: authorRole ?? null,
        bodyPreview: sanitizedBody.slice(0, 100) + (sanitizedBody.length > 100 ? "..." : ""),
        provider: providerType,
      });

      return jsonResult({
        success: true, issueId, issueTitle: issue.title, issueUrl: issue.web_url,
        commentAdded: true, authorRole: authorRole ?? null, bodyLength: sanitizedBody.length,
        project: project.name, provider: providerType,
        announcement: `💬 Comment added to #${issueId}${authorRole ? ` by ${authorRole.toUpperCase()}` : ""}`,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function getRoleEmoji(role: string): string {
  if (role === "orchestrator") return "🎛️";
  return getFallbackEmoji(role);
}

function isReviewerSession(
  project: Awaited<ReturnType<typeof resolveProjectFromContext>>["project"],
  sessionKey?: string,
): boolean {
  if (!sessionKey) return false;
  const reviewer = getRoleWorker(project, "reviewer");
  for (const slots of Object.values(reviewer.levels)) {
    for (const slot of slots) {
      if (slot.sessionKey === sessionKey) return true;
    }
  }
  return false;
}
