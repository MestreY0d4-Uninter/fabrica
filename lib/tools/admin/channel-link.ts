/**
 * channel_link — Attach this chat to a project.
 *
 * Links the current channel/chat to a registered project. If the channel
 * is already linked to a different project, the old bond is removed first
 * (auto-detach). This is the primary way to switch which project a chat
 * controls.
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { PluginContext } from "../../context.js";
import type { ToolContext } from "../../types.js";
import { readProjects, writeProjects, type Channel, buildRouteRef, routeMatchesChannel } from "../../projects/index.js";
import { log as auditLog } from "../../audit.js";
import { requireWorkspaceDir } from "../helpers.js";

export function createChannelLinkTool(_ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "channel_link",
    label: "Channel Link",
    description:
      "Link this chat/channel to a project. If this channel is already linked to another project, " +
      "it is automatically detached first. Use this to switch projects or connect a new chat.",
    parameters: {
      type: "object",
      required: ["channelId", "project"],
      properties: {
        channelId: {
          type: "string",
          description:
            "YOUR chat/group ID — the numeric ID of the chat you are in right now (e.g. '-1003844794417'). " +
            "Do NOT guess; use the ID of the conversation this message came from.",
        },
        messageThreadId: {
          type: "number",
          description: "Optional Telegram forum topic ID when linking a specific topic instead of the whole group root.",
        },
        project: {
          type: "string",
          description:
            "Project name or slug to link to (e.g. 'fabrica'). Must already be registered via project_register.",
        },
        channel: {
          type: "string",
          enum: ["telegram", "whatsapp", "discord", "slack"],
          description: "Channel type. Defaults to 'telegram'.",
        },
        name: {
          type: "string",
          description:
            "Display name for this channel (e.g. 'general', 'dev-chat'). Auto-generated if omitted.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const channelId = params.channelId as string;
      const messageThreadId = typeof params.messageThreadId === "number" ? params.messageThreadId : undefined;
      const projectRef = params.project as string;
      const channelType = (params.channel as Channel["channel"]) ?? "telegram";
      const channelName = params.name as string | undefined;
      const workspaceDir = requireWorkspaceDir(toolCtx);
      const targetRoute = buildRouteRef({
        channel: channelType,
        channelId,
        messageThreadId,
        accountId: toolCtx.agentAccountId,
      });

      if (!channelId) throw new Error("channelId is required.");
      if (!projectRef) throw new Error("project is required.");

      const data = await readProjects(workspaceDir);

      // Resolve target project by slug or name
      const slug = projectRef.toLowerCase().replace(/\s+/g, "-");
      const target =
        data.projects[slug] ??
        Object.values(data.projects).find(
          (p) => p.name.toLowerCase() === projectRef.toLowerCase(),
        );

      if (!target) {
        const available = Object.values(data.projects)
          .map((p) => p.name)
          .join(", ");
        throw new Error(
          `Project "${projectRef}" not found. Available projects: ${available || "none"}. ` +
            `Register a project first with project_register.`,
        );
      }

      // Already linked to this project?
      const alreadyLinked = target.channels.some(
        (ch) => routeMatchesChannel(targetRoute, ch),
      );
      if (alreadyLinked) {
        return jsonResult({
          success: true,
          changed: false,
          project: target.name,
          projectSlug: target.slug,
          channelId,
          messageThreadId: targetRoute.messageThreadId ?? null,
          announcement: `Channel already linked to "${target.name}".`,
        });
      }

      // Auto-detach from any other project that has this channelId
      let detachedFrom: string | null = null;
      for (const project of Object.values(data.projects)) {
        const idx = project.channels.findIndex(
          (ch) => routeMatchesChannel(targetRoute, ch),
        );
        if (idx !== -1) {
          detachedFrom = project.name;
          project.channels.splice(idx, 1);
          break;
        }
      }

      // Attach to target project
      const newChannel: Channel = {
        channelId: targetRoute.channelId,
        channel: targetRoute.channel,
        name: channelName ?? `channel-${target.channels.length + 1}`,
        events: ["*"],
        accountId: targetRoute.accountId ?? undefined,
        messageThreadId: targetRoute.messageThreadId ?? undefined,
      };
      target.channels.push(newChannel);

      await writeProjects(workspaceDir, data);

      await auditLog(workspaceDir, "channel_link", {
        project: target.name,
        projectSlug: target.slug,
        channelId,
        messageThreadId: targetRoute.messageThreadId ?? null,
        channelType,
        channelName: newChannel.name,
        detachedFrom,
      });

      const detachNote = detachedFrom
        ? ` (detached from "${detachedFrom}")`
        : "";
      return jsonResult({
        success: true,
        changed: true,
        project: target.name,
        projectSlug: target.slug,
        channelId,
        messageThreadId: targetRoute.messageThreadId ?? null,
        channelName: newChannel.name,
        detachedFrom,
        announcement: `Channel linked to "${target.name}"${detachNote}.`,
      });
    },
  });
}
