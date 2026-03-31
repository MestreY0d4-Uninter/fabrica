import { jsonResult } from "../../runtime/plugin-sdk-compat.js";
import type { PluginContext } from "../../context.js";
import type { ToolContext } from "../../types.js";
import { log as auditLog } from "../../audit.js";
import {
  requireWorkspaceDir,
  resolveProjectFromContext,
  resolveProvider,
} from "../helpers.js";
import { sanitizePublicOutput } from "./public-output-sanitizer.js";
import { recordIssueLifecycleBySessionKey, requireCanonicalPrSelector } from "../../projects/index.js";
import { parseFabricaSessionKey } from "../../dispatch/bootstrap-hook.js";

export function createReviewSubmitTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "review_submit",
    label: "Review Submit",
    description: `Submit canonical review feedback to the PR linked to an issue.

It writes the review to the PR itself, preferring a formal PR review and
falling back to a top-level PR conversation comment when necessary.`,
    parameters: {
      type: "object",
      required: ["channelId", "issueId", "result", "body"],
      properties: {
        channelId: {
          type: "string",
          description: "Project slug from the task message, or your current numeric channel ID.",
        },
        issueId: {
          type: "number",
          description: "Issue ID whose linked PR should receive the review artifact.",
        },
        result: {
          type: "string",
          enum: ["approve", "reject"],
          description: "Review outcome to submit to the PR.",
        },
        body: {
          type: "string",
          description: "Review body in markdown. Be specific and actionable.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const issueId = params.issueId as number;
      const result = params.result as "approve" | "reject";
      const body = params.body as string;
      const workspaceDir = requireWorkspaceDir(toolCtx);
      const workerSession = toolCtx.sessionKey ? parseFabricaSessionKey(toolCtx.sessionKey) : null;

      if (workerSession) {
        await auditLog(workspaceDir, "review_submit_blocked", {
          project: workerSession.projectName,
          role: workerSession.role,
          issue: issueId,
          sessionKey: toolCtx.sessionKey,
          reason: "fabrica_worker_session",
        }).catch(() => {});
        throw new Error(
          workerSession.role === "reviewer"
            ? "Reviewer workers must finish by ending their response with `Review result: APPROVE` or `Review result: REJECT`. Do not call review_submit."
            : "Fabrica worker sessions must not call review_submit. Use the role's normal completion contract instead.",
        );
      }

      await recordIssueLifecycleBySessionKey({
        workspaceDir,
        sessionKey: toolCtx.sessionKey,
        stage: "first_worker_activity",
        details: { source: "review_submit" },
      }).catch(() => {});

      if (!body || body.trim().length === 0) {
        throw new Error("Review body cannot be empty.");
      }

      const { project } = await resolveProjectFromContext(workspaceDir, toolCtx, params.channelId as string | undefined);
      const { provider, type: providerType } = await resolveProvider(project, ctx.runCommand, ctx.pluginConfig);
      const prSelector = requireCanonicalPrSelector(project, issueId, "submit a review");
      const review = await provider.submitPrReview(issueId, {
        result,
        body: sanitizePublicOutput(body),
      }, prSelector);
      const identity = await provider.getProviderIdentity().catch(() => ({ mode: "unknown" as const }));

      await auditLog(workspaceDir, "review_submit", {
        project: project.name,
        issue: issueId,
        sessionKey: toolCtx.sessionKey ?? null,
        provider: providerType,
        providerIdentity: identity.mode,
        result,
        artifactType: review.artifactType,
        artifactId: review.artifactId,
        prUrl: review.prUrl,
        usedFallback: review.usedFallback,
        fallbackReason: review.fallbackReason ?? null,
        bodyPreview: body.slice(0, 200) + (body.length > 200 ? "..." : ""),
      });

      return jsonResult({
        success: true,
        issueId,
        project: project.name,
        provider: providerType,
        result,
        artifactType: review.artifactType,
        artifactId: review.artifactId,
        prUrl: review.prUrl,
        usedFallback: review.usedFallback,
        fallbackReason: review.fallbackReason ?? null,
        announcement: `${result === "approve" ? "✅" : "⚠️"} Review submitted on PR for #${issueId}`,
      });
    },
  });
}
