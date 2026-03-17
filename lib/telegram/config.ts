export type FabricaTelegramConfig = {
  bootstrapDmEnabled: boolean;
  projectsForumChatId?: string;
  projectsForumAccountId?: string;
  opsChatId?: string;
};

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function readFabricaTelegramConfig(pluginConfig?: Record<string, unknown>): FabricaTelegramConfig {
  const section = (pluginConfig?.telegram ?? {}) as Record<string, unknown>;
  return {
    bootstrapDmEnabled: readBoolean(section.bootstrapDmEnabled, true),
    projectsForumChatId:
      readString(section.projectsForumChatId) ??
      readString(process.env.FABRICA_PROJECTS_CHANNEL_ID),
    projectsForumAccountId:
      readString(section.projectsForumAccountId) ??
      readString(process.env.FABRICA_PROJECTS_CHANNEL_ACCOUNT_ID),
    opsChatId:
      readString(section.opsChatId) ??
      readString(process.env.TELEGRAM_CHAT_ID),
  };
}
