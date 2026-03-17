import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export type CreatedTelegramTopic = {
  chatId: string;
  topicId: number;
  name: string;
  /** True if this is the General fallback topic (messageThreadId=1) */
  isFallback?: boolean;
};

type MessageActionResult = {
  details?: {
    ok?: boolean;
    chatId?: string;
    topicId?: number;
    name?: string;
  };
};

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createProjectForumTopic(
  ctx: {
    runtime: OpenClawPluginApi["runtime"];
    config: OpenClawPluginApi["config"];
  },
  opts: {
    chatId: string;
    name: string;
    accountId?: string;
  },
): Promise<CreatedTelegramTopic> {
  const maxAttempts = 3;
  const delays = [1000, 2000, 4000];
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await ctx.runtime.channel.telegram.messageActions.handleAction?.({
        channel: "telegram",
        action: "topic-create",
        cfg: ctx.config as any,
        accountId: opts.accountId,
        params: {
          to: opts.chatId,
          name: opts.name,
        },
      }) as MessageActionResult | undefined;

      const details = result?.details;
      if (!details?.ok || typeof details.topicId !== "number") {
        throw new Error("Telegram topic creation did not return a topicId");
      }

      return {
        chatId: String(details.chatId ?? opts.chatId),
        topicId: details.topicId,
        name: String(details.name ?? opts.name),
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts - 1) {
        await sleep(delays[attempt]!);
      }
    }
  }

  // Fallback: use General topic (messageThreadId=1)
  return {
    chatId: opts.chatId,
    topicId: 1,
    name: opts.name,
    isFallback: true,
  };
}
