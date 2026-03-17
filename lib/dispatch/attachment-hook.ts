/**
 * attachment-hook.ts — Register message_received hook for attachment capture.
 *
 * Channel-agnostic: works with any OpenClaw channel (Telegram, Discord,
 * WhatsApp, Signal, Slack, etc.) since all channels normalize media into
 * MediaPath/MediaPaths in the message metadata.
 *
 * Listens for incoming messages with media and issue references (#N).
 * When both are present, reads the local file and associates it with the issue.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginContext } from "../context.js";
import {
  extractMediaAttachments,
  extractIssueReferences,
  processAttachmentMessage,
} from "./attachments.js";
import { getProjectByRoute, parseConversationRoute, readProjects, type Project } from "../projects/index.js";
import { createProvider } from "../providers/index.js";
import { log as auditLog } from "../audit.js";

/**
 * Resolve which project a conversation maps to.
 * Looks up the conversationId in registered projects' channels.
 */
async function resolveProjectFromChannel(
  workspaceDir: string,
  channel: Project["channels"][number]["channel"],
  conversationId: string,
  messageThreadId?: number,
): Promise<Project | null> {
  try {
    const data = await readProjects(workspaceDir);
    const route = parseConversationRoute(channel, conversationId, messageThreadId);
    return getProjectByRoute(data, route) ?? null;
  } catch { /* no projects yet */ }
  return null;
}

/**
 * Resolve the workspace directory from OpenClaw config.
 * Uses only explicitly configured workspaces so the plugin stays portable and
 * does not depend on legacy OpenClaw layouts.
 */
export function resolveWorkspaceDir(config: Record<string, unknown>): string | null {
  const agents = config.agents as { defaults?: { workspace?: string }; list?: Array<{ id: string; workspace?: string }> } | undefined;
  if (agents?.defaults?.workspace) return agents.defaults.workspace;
  const workspaces = (agents?.list ?? []).map((agent) => agent.workspace).filter((workspace): workspace is string => Boolean(workspace));
  if (workspaces.length === 1) return workspaces[0] ?? null;
  return null;
}

/**
 * Register the message_received hook for attachment handling.
 *
 * Channel-agnostic: OpenClaw downloads media from all channels and stores
 * it locally, exposing MediaPath/MediaPaths in the message metadata.
 */
export function registerAttachmentHook(api: OpenClawPluginApi, ctx: PluginContext): void {
  api.on("message_received", async (event, eventCtx) => {
    const metadata = event.metadata;
    if (!metadata || typeof metadata !== "object") return;

    // Check for media in the message (channel-agnostic)
    const attachments = extractMediaAttachments(metadata as Record<string, unknown>);
    if (attachments.length === 0) return;

    // Check for issue references in the message text
    const issueIds = extractIssueReferences(event.content ?? "");
    if (issueIds.length === 0) return;

    // Resolve workspace directory
    const workspaceDir = resolveWorkspaceDir(ctx.config as unknown as Record<string, unknown>);
    if (!workspaceDir) return;

    const conversationId = eventCtx.conversationId;
    if (!conversationId) return;
    const messageThreadId =
      typeof (metadata as Record<string, unknown>).message_thread_id === "number"
        ? ((metadata as Record<string, unknown>).message_thread_id as number)
        : undefined;

    const project = await resolveProjectFromChannel(
      workspaceDir,
      eventCtx.channelId as Project["channels"][number]["channel"],
      conversationId,
      messageThreadId,
    );
    if (!project) return;

    // Process each referenced issue
    for (const issueId of issueIds) {
      try {
        const { provider } = await createProvider({ repo: project.repo, provider: project.provider, runCommand: ctx.runCommand });

        await processAttachmentMessage({
          workspaceDir,
          projectSlug: project.slug,
          issueId,
          provider,
          uploader: event.from ?? "unknown",
          mediaAttachments: attachments,
        });

        ctx.logger.info(
          `Attachment hook: ${attachments.length} file(s) attached to #${issueId} in "${project.name}" via ${eventCtx.channelId}`,
        );
      } catch (err) {
        ctx.logger.warn(
          `Attachment hook: failed for #${issueId} in "${project.name}": ${(err as Error).message}`,
        );
        await auditLog(workspaceDir, "attachment_hook_error", {
          project: project.name,
          issueId,
          channel: eventCtx.channelId,
          error: (err as Error).message ?? String(err),
        }).catch(() => {});
      }
    }
  });
}
