import type { Channel, Project, ProjectsData } from "./types.js";

export type RouteRef = {
  channel: Channel["channel"];
  channelId: string;
  messageThreadId?: number;
  accountId?: string;
};

type RouteInput = Pick<RouteRef, "channel" | "channelId"> & {
  messageThreadId?: number | string | null;
  accountId?: string | null;
};

function normalizeThreadId(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildRouteRef(route: RouteInput): RouteRef {
  return {
    channel: route.channel,
    channelId: String(route.channelId),
    messageThreadId: normalizeThreadId(route.messageThreadId),
    accountId: route.accountId?.trim() || undefined,
  };
}

export function routeKey(route: RouteInput): string {
  const normalized = buildRouteRef(route);
  return [
    normalized.channel,
    normalized.channelId,
    normalized.messageThreadId ?? "root",
    normalized.accountId ?? "default",
  ].join(":");
}

export function channelRouteKey(channel: Channel): string {
  return routeKey({
    channel: channel.channel,
    channelId: channel.channelId,
    messageThreadId: channel.messageThreadId,
    accountId: channel.accountId,
  });
}

export function routeMatchesChannel(route: RouteInput, channel: Channel): boolean {
  return channelRouteKey(channel) === routeKey(route);
}

export function routeMatchesProject(route: RouteInput, project: Project): boolean {
  return project.channels.some((channel) => routeMatchesChannel(route, channel));
}

export function findProjectByRoute(
  data: ProjectsData,
  route: RouteInput,
): { slug: string; project: Project } | undefined {
  for (const [slug, project] of Object.entries(data.projects)) {
    if (routeMatchesProject(route, project)) {
      return { slug, project };
    }
  }
  return undefined;
}

export function findProjectByChannelId(data: ProjectsData, channelId: string): { slug: string; project: Project } | undefined {
  let match: { slug: string; project: Project } | undefined;
  for (const [slug, project] of Object.entries(data.projects)) {
    if (project.channels.some((channel) => String(channel.channelId) === String(channelId))) {
      if (match) return undefined;
      match = { slug, project };
    }
  }
  return match;
}

export function findProjectsByChannelId(data: ProjectsData, channelId: string): Array<{ slug: string; project: Project }> {
  return Object.entries(data.projects)
    .filter(([, project]) => project.channels.some((channel) => String(channel.channelId) === String(channelId)))
    .map(([slug, project]) => ({ slug, project }));
}

export function isForumProject(project: Project, channelId?: string): boolean {
  return project.channels.some((channel) =>
    (channelId === undefined || String(channel.channelId) === String(channelId)) &&
    channel.messageThreadId !== undefined &&
    channel.messageThreadId !== null);
}

export function findPrimaryChannel(project: Project): Channel | undefined {
  return project.channels.find((channel) => channel.name === "primary") ?? project.channels[0];
}

export function parseConversationRoute(
  channel: Channel["channel"],
  conversationId: string,
  messageThreadId?: number | string | null,
  accountId?: string | null,
): RouteRef {
  const topicMatch = String(conversationId).match(/^(-?\d+):topic:(\d+)$/);
  if (topicMatch) {
    return buildRouteRef({
      channel,
      channelId: topicMatch[1]!,
      messageThreadId: Number.parseInt(topicMatch[2]!, 10),
      accountId,
    });
  }

  return buildRouteRef({
    channel,
    channelId: String(conversationId),
    messageThreadId,
    accountId,
  });
}
