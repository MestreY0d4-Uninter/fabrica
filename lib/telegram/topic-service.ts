import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";

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

type TelegramTokenResolution = {
  token: string;
  source: "config" | "tokenFile" | "env" | "none";
};

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAccountId(accountId?: string | null): string {
  const trimmed = accountId?.trim().toLowerCase();
  return trimmed || "default";
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  return undefined;
}

function readResolvedSecretString(value: unknown): string | undefined {
  const direct = readString(value);
  if (direct) return direct;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["value", "resolved", "secret", "current"]) {
    const candidate = readString(record[key]);
    if (candidate) return candidate;
  }

  return undefined;
}

async function tryReadTokenFile(filePath: unknown): Promise<string | undefined> {
  const resolvedPath = readString(filePath);
  if (!resolvedPath) return undefined;

  try {
    const token = await fs.readFile(resolvedPath, "utf-8");
    const trimmed = token.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

async function resolveTelegramToken(
  ctx: {
    runtime: OpenClawPluginApi["runtime"];
    config: OpenClawPluginApi["config"];
  },
  accountId?: string,
): Promise<TelegramTokenResolution> {
  const telegramRuntime = (ctx.runtime as any)?.channel?.telegram as
    | {
      resolveTelegramToken?: (
        cfg?: unknown,
        opts?: { envToken?: string | null; accountId?: string | null },
      ) => { token?: string; source?: TelegramTokenResolution["source"] };
    }
    | undefined;

  if (typeof telegramRuntime?.resolveTelegramToken === "function") {
    const resolved = telegramRuntime.resolveTelegramToken(ctx.config as any, {
      accountId: accountId ?? null,
      envToken: process.env.TELEGRAM_BOT_TOKEN ?? null,
    });
    const token = readString(resolved?.token);
    if (token) {
      return {
        token,
        source: resolved?.source ?? "config",
      };
    }
  }

  const cfg = (ctx.config ?? {}) as Record<string, any>;
  const telegramCfg = cfg.channels?.telegram as Record<string, any> | undefined;
  const normalizedAccountId = normalizeAccountId(accountId);
  const accounts = telegramCfg?.accounts && typeof telegramCfg.accounts === "object" && !Array.isArray(telegramCfg.accounts)
    ? telegramCfg.accounts as Record<string, Record<string, unknown>>
    : undefined;
  const accountCfg = accounts
    ? (accounts[normalizedAccountId]
      ?? Object.entries(accounts).find(([key]) => normalizeAccountId(key) === normalizedAccountId)?.[1])
    : undefined;

  const accountTokenFile = await tryReadTokenFile(accountCfg?.tokenFile);
  if (accountTokenFile) {
    return { token: accountTokenFile, source: "tokenFile" };
  }

  const accountToken = readResolvedSecretString(accountCfg?.botToken);
  if (accountToken) {
    return { token: accountToken, source: "config" };
  }

  const defaultTokenFile = await tryReadTokenFile(telegramCfg?.tokenFile);
  if (defaultTokenFile) {
    return { token: defaultTokenFile, source: "tokenFile" };
  }

  const configToken = readResolvedSecretString(telegramCfg?.botToken);
  if (configToken) {
    return { token: configToken, source: "config" };
  }

  const envToken = normalizedAccountId === "default"
    ? readString(process.env.TELEGRAM_BOT_TOKEN)
    : undefined;
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  return { token: "", source: "none" };
}

function isRecoverableTopicRuntimeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Cannot read properties of undefined|is not a function|did not return a topicId|runtime unavailable/i.test(message);
}

async function createProjectForumTopicViaBotApi(
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
  const { token } = await resolveTelegramToken(ctx, opts.accountId);
  if (!token) {
    throw new Error("Telegram topic creation fallback could not resolve a bot token");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/createForumTopic`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: opts.chatId,
      name: opts.name,
    }),
  });

  const payload = await response.json().catch(() => null) as
    | {
      ok?: boolean;
      description?: string;
      result?: {
        message_thread_id?: number;
        name?: string;
      };
    }
    | null;

  if (!response.ok || !payload?.ok) {
    throw new Error(
      payload?.description
      ?? `Telegram createForumTopic failed with HTTP ${response.status}`,
    );
  }

  const topicId = payload.result?.message_thread_id;
  if (typeof topicId !== "number") {
    throw new Error("Telegram topic creation fallback did not return a topicId");
  }

  return {
    chatId: opts.chatId,
    topicId,
    name: String(payload.result?.name ?? opts.name),
  };
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
  const telegramMessageActions = (ctx.runtime as any)?.channel?.telegram?.messageActions;
  const handleAction = telegramMessageActions?.handleAction as
    | ((input: Record<string, unknown>) => Promise<MessageActionResult | undefined>)
    | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (typeof handleAction === "function") {
        const result = await handleAction({
          channel: "telegram",
          action: "topic-create",
          cfg: ctx.config as any,
          accountId: opts.accountId,
          params: {
            to: opts.chatId,
            name: opts.name,
          },
        });

        const details = result?.details;
        if (!details?.ok || typeof details.topicId !== "number") {
          throw new Error("Telegram topic creation did not return a topicId");
        }

        return {
          chatId: String(details.chatId ?? opts.chatId),
          topicId: details.topicId,
          name: String(details.name ?? opts.name),
        };
      }

      return await createProjectForumTopicViaBotApi(ctx, opts);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (typeof handleAction === "function" && isRecoverableTopicRuntimeError(error)) {
        try {
          return await createProjectForumTopicViaBotApi(ctx, opts);
        } catch (fallbackError) {
          lastError = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
        }
      } else {
        lastError = error;
      }
      if (attempt < maxAttempts - 1) {
        await sleep(delays[attempt]!);
      }
    }
  }

  throw lastError ?? new Error("Telegram topic creation failed after retry exhaustion");
}
