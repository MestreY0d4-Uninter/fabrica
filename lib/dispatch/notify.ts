/**
 * notify.ts — Programmatic alerting for worker lifecycle events.
 *
 * Sends notifications to project groups for visibility into the DevClaw pipeline.
 *
 * Event types:
 * - workerStart: Worker spawned/resumed for a task (→ project group)
 * - workerComplete: Worker completed task (→ project group)
 * - reviewNeeded: Issue needs review — human or agent (→ project group)
 * - prMerged: PR/MR was merged into the base branch (→ project group)
 */
import { log as auditLog } from "../audit.js";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { RunCommand } from "../context.js";
import { randomUUID } from "node:crypto";
import {
  computeNotifyKey,
  writeIntent,
  markDelivered,
} from "./notification-outbox.js";

/** Per-event-type toggle. All default to true — set to false to suppress. */
export type NotificationConfig = Partial<Record<NotifyEvent["type"], boolean>>;

export type NotificationTarget = {
  channelId: string;
  channel: string;
  accountId?: string;
  messageThreadId?: number;
};

export type NotifyEvent =
  | {
      type: "workerStart";
      project: string;
      issueId: number;
      issueTitle: string;
      issueUrl: string;
      role: string;
      level: string;
      name?: string;
      sessionAction: "spawn" | "send";
      modelDowngraded?: boolean;
      originalModel?: string;
      effectiveModel?: string;
    }
  | {
      type: "workerComplete";
      project: string;
      issueId: number;
      issueUrl: string;
      role: string;
      level?: string;
      name?: string;
      result: "done" | "pass" | "fail" | "refine" | "blocked";
      summary?: string;
      nextState?: string;
      prUrl?: string;
      createdTasks?: Array<{ id: number; title: string; url: string }>;
    }
  | {
      type: "reviewNeeded";
      project: string;
      issueId: number;
      issueUrl: string;
      issueTitle: string;
      routing: "human" | "agent";
      prUrl?: string;
    }
  | {
      type: "prMerged";
      project: string;
      issueId: number;
      issueUrl: string;
      issueTitle: string;
      prUrl?: string;
      prTitle?: string;
      sourceBranch?: string;
      mergedBy: "heartbeat" | "agent" | "pipeline";
    }
  | {
      type: "changesRequested";
      project: string;
      issueId: number;
      issueUrl: string;
      issueTitle: string;
      prUrl?: string;
    }
  | {
      type: "mergeConflict";
      project: string;
      issueId: number;
      issueUrl: string;
      issueTitle: string;
      prUrl?: string;
    }
  | {
      type: "prClosed";
      project: string;
      issueId: number;
      issueUrl: string;
      issueTitle: string;
      prUrl?: string;
    }
  | {
      type: "issueComplete";
      project: string;
      issueId: number;
      issueUrl: string;
      issueTitle: string;
      prUrl?: string;
    }
  | {
      type: "holdEscapeResolved";
      project: string;
      issueId: number;
      issueUrl: string;
      issueTitle: string;
      prUrl?: string;
      fromState: string;
    }
  | {
      type: "infraFailure";
      project: string;
      issueId: number;
      issueUrl: string;
      summary: string;
      infraFailCount: number;
    };

/**
 * Format a worker identification string in a standardized format.
 *
 * Combines role, worker name, and level into a consistent format:
 * - "DEVELOPER" (no name/level)
 * - "DEVELOPER Herminia" (name only)
 * - "DEVELOPER (junior)" (level only)
 * - "DEVELOPER Herminia (junior)" (name and level)
 *
 * This ensures consistency across all notifications that reference a worker.
 */
function formatWorkerString(
  role: string,
  opts?: { name?: string; level?: string },
): string {
  const roleUpper = role.toUpperCase();
  const parts = [roleUpper];

  if (opts?.name) {
    parts.push(opts.name);
  }

  if (opts?.level) {
    parts.push(`(${opts.level})`);
  }

  return parts.join(" ");
}

/**
 * Extract a PR/MR number from a URL.
 * GitHub: .../pull/123  GitLab: .../merge_requests/123
 * Returns null if not parseable.
 */
function extractPrNumber(url: string): number | null {
  const m = url.match(/\/(?:pull|merge_requests)\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Format a PR/MR link with a descriptive label including the PR number.
 * Example: [Pull Request #253](url) or [Merge Request #253](url)
 */
function prLink(url: string): string {
  const num = extractPrNumber(url);
  const isGitLab = url.includes("merge_requests");
  const label = isGitLab
    ? `Merge Request${num != null ? ` #${num}` : ""}`
    : `Pull Request${num != null ? ` #${num}` : ""}`;
  return `[${label}](${url})`;
}

/**
 * Build a human-readable message for a notification event.
 */
function buildMessage(event: NotifyEvent): string {
  switch (event.type) {
    case "workerStart": {
      const action = event.sessionAction === "spawn" ? "🚀 Started" : "▶️ Resumed";
      const worker = formatWorkerString(event.role, {
        name: event.name,
        level: event.level,
      });
      let msg = `${action} ${worker} on #${event.issueId}: ${event.issueTitle}\n🔗 [Issue #${event.issueId}](${event.issueUrl})`;
      if (event.modelDowngraded && event.originalModel && event.effectiveModel) {
        msg += `\n⚠️ Modelo: ${event.originalModel} → ${event.effectiveModel}`;
      }
      return msg;
    }

    case "workerComplete": {
      const icons: Record<string, string> = {
        done: "✅",
        pass: "🎉",
        fail: "❌",
        refine: "🤔",
        blocked: "🚫",
      };
      const icon = icons[event.result] ?? "📋";
      const resultText: Record<string, string> = {
        done: "completed",
        pass: "PASSED",
        fail: "FAILED",
        refine: "needs refinement",
        blocked: "BLOCKED",
      };
      const text = resultText[event.result] ?? event.result;
      // Header: status + issue reference
      const worker = formatWorkerString(event.role, {
        name: event.name,
        level: event.level,
      });
      let msg = `${icon} ${worker} ${text} #${event.issueId}`;
      // Summary: on its own line for readability
      if (event.summary) {
        msg += `\n${event.summary}`;
      }
      // Links: PR and issue on separate lines
      if (event.prUrl) msg += `\n🔗 ${prLink(event.prUrl)}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
      // Created tasks (e.g. architect implementation tasks)
      if (event.createdTasks && event.createdTasks.length > 0) {
        msg += `\n📌 Created tasks:`;
        for (const t of event.createdTasks) {
          msg += `\n  · [#${t.id}: ${t.title}](${t.url})`;
        }
        msg += `\nReply to start working on them.`;
      }
      // Workflow transition: at the end
      if (event.nextState) {
        msg += `\n→ ${event.nextState}`;
      }
      return msg;
    }

    case "reviewNeeded": {
      const icon = event.routing === "human" ? "👀" : "🤖";
      const who = event.routing === "human" ? "Human review needed" : "Agent review queued";
      let msg = `${icon} ${who} for #${event.issueId}: ${event.issueTitle}`;
      if (event.prUrl) msg += `\n🔗 ${prLink(event.prUrl)}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
      return msg;
    }

    case "prMerged": {
      const via: Record<string, string> = {
        heartbeat: "auto-merged after approval",
        agent: "merged by agent reviewer",
        pipeline: "merged by reviewer",
      };
      let msg = `🔀 PR merged for #${event.issueId}: ${event.issueTitle}`;
      if (event.prTitle) msg += `\n📝 ${event.prTitle}`;
      if (event.sourceBranch) msg += `\n🌿 ${event.sourceBranch} → main`;
      msg += `\n⚡ ${via[event.mergedBy] ?? event.mergedBy}`;
      if (event.prUrl) msg += `\n🔗 ${prLink(event.prUrl)}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
      return msg;
    }

    case "changesRequested": {
      let msg = `⚠️ Changes requested on PR for #${event.issueId}: ${event.issueTitle}`;
      if (event.prUrl) msg += `\n🔗 ${prLink(event.prUrl)}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
      msg += `\n→ Moving to To Improve for developer re-dispatch`;
      return msg;
    }

    case "mergeConflict": {
      let msg = `⚠️ Merge conflicts detected on PR for #${event.issueId}: ${event.issueTitle}`;
      if (event.prUrl) msg += `\n🔗 ${prLink(event.prUrl)}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
      msg += `\n→ Moving to To Improve — developer will rebase and resolve`;
      return msg;
    }

    case "prClosed": {
      let msg = `🚫 PR closed without merging for #${event.issueId}: ${event.issueTitle}`;
      if (event.prUrl) msg += `\n🔗 ${prLink(event.prUrl)}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
      msg += `\n→ Moving to To Improve for developer attention`;
      return msg;
    }

    case "issueComplete": {
      let msg = `🏁 Issue completed: #${event.issueId} — ${event.issueTitle}`;
      msg += `\n📦 Project: ${event.project}`;
      if (event.prUrl) msg += `\n🔗 ${prLink(event.prUrl)}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
      msg += `\n✅ Issue closed — work delivered.`;
      return msg;
    }

    case "holdEscapeResolved": {
      let msg = `✅ Auto-resolved: #${event.issueId} — ${event.issueTitle}`;
      msg += `\nPR merged — issue closed automatically (was stuck in ${event.fromState})`;
      if (event.prUrl) msg += `\n🔗 ${prLink(event.prUrl)}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
      msg += `\n🏁 Done — no human action needed.`;
      return msg;
    }

    case "infraFailure": {
      const icon = event.infraFailCount >= 2 ? "🚨" : "⚠️";
      let msg = `${icon} Infrastructure failure on #${event.issueId} (attempt ${event.infraFailCount})`;
      msg += `\n${event.summary}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
      if (event.infraFailCount >= 2) {
        msg += `\n→ Circuit breaker tripped — moved to Refining (operator intervention required)`;
      } else {
        msg += `\n→ Returned to To Test queue — will retry after toolchain is fixed`;
      }
      return msg;
    }
  }
}

/**
 * Send a notification message via the plugin runtime API.
 *
 * Uses the runtime's native send functions to bypass CLI → WebSocket timeouts.
 * Falls back gracefully on error (notifications shouldn't break the main flow).
 */
async function sendMessage(
  target: string,
  message: string,
  channel: string,
  workspaceDir: string,
  runtime?: PluginRuntime,
  accountId?: string,
  runCommand?: RunCommand,
  messageThreadId?: number,
  auditMeta?: {
    eventId: string;
    correlationId: string;
    issueId: number;
    eventType: NotifyEvent["type"];
    target: NotificationTarget;
  },
): Promise<boolean> {
  let lastError: Error | null = null;
  const maxAttempts = channel === "telegram" ? 3 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (auditMeta) {
        await auditLog(workspaceDir, "notify_attempt", {
          eventId: auditMeta.eventId,
          correlationId: auditMeta.correlationId,
          issue: auditMeta.issueId,
          eventType: auditMeta.eventType,
          attempt,
          target: auditMeta.target.channelId,
          channel: auditMeta.target.channel,
          accountId: auditMeta.target.accountId ?? null,
          messageThreadId: auditMeta.target.messageThreadId ?? null,
        });
      }
      await sendMessageOnce(target, message, channel, runtime, accountId, runCommand, messageThreadId);
      if (auditMeta) {
        await auditLog(workspaceDir, "notify_sent", {
          eventId: auditMeta.eventId,
          correlationId: auditMeta.correlationId,
          issue: auditMeta.issueId,
          eventType: auditMeta.eventType,
          attempts: attempt,
          target: auditMeta.target.channelId,
          channel: auditMeta.target.channel,
          accountId: auditMeta.target.accountId ?? null,
          messageThreadId: auditMeta.target.messageThreadId ?? null,
        });
      }
      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;
      if (attempt >= maxAttempts || !isTransientNotifyError(error)) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }

  await auditLog(workspaceDir, "notify_error", {
    eventId: auditMeta?.eventId ?? null,
    correlationId: auditMeta?.correlationId ?? null,
    issue: auditMeta?.issueId ?? null,
    eventType: auditMeta?.eventType ?? null,
    target,
    channel,
    accountId: auditMeta?.target.accountId ?? null,
    messageThreadId: auditMeta?.target.messageThreadId ?? null,
    error: lastError?.message ?? "unknown error",
  });
  return false;
}

async function sendMessageOnce(
  target: string,
  message: string,
  channel: string,
  runtime?: PluginRuntime,
  accountId?: string,
  runCommand?: RunCommand,
  messageThreadId?: number,
): Promise<void> {
  // Use runtime API when available (avoids CLI subprocess timeouts)
  if (runtime) {
    if (channel === "telegram") {
      // Cast to any to bypass TypeScript type limitation; disableWebPagePreview and messageThreadId are valid in Telegram API
      const telegramOpts: Record<string, unknown> = { silent: true, disableWebPagePreview: true, accountId };
      if (messageThreadId != null) telegramOpts.messageThreadId = messageThreadId;
      await runtime.channel.telegram.sendMessageTelegram(target, message, telegramOpts as any);
      return;
    }
    if (channel === "whatsapp") {
      await runtime.channel.whatsapp.sendMessageWhatsApp(target, message, { verbose: false, accountId });
      return;
    }
    if (channel === "discord") {
      await runtime.channel.discord.sendMessageDiscord(target, message, { accountId });
      return;
    }
    if (channel === "slack") {
      await runtime.channel.slack.sendMessageSlack(target, message, { accountId });
      return;
    }
    if (channel === "signal") {
      await runtime.channel.signal.sendMessageSignal(target, message, { accountId });
      return;
    }
  }

  if (!runCommand) throw new Error("runCommand is required when runtime is not available");
  const cliArgs = [
    "openclaw",
    "message",
    "send",
    "--channel",
    channel,
    "--target",
    target,
    "--message",
    message,
    "--json",
  ];
  if (accountId) {
    cliArgs.push("--account", accountId);
  }
  if (messageThreadId != null) {
    cliArgs.push("--thread-id", String(messageThreadId));
  }
  await runCommand(
    cliArgs,
    { timeoutMs: 30_000 },
  );
}

function isTransientNotifyError(err: Error): boolean {
  return /\b(5\d\d|gateway timeout|timeout|timed out|etimedout|econnreset|temporarily unavailable)\b/i.test(err.message);
}

/**
 * Send a notification for a worker lifecycle event.
 *
 * Returns true if notification was sent, false on error.
 */
export async function notify(
  event: NotifyEvent,
  opts: {
    workspaceDir: string;
    config?: NotificationConfig;
    /** Target for project-scoped notifications */
    target?: NotificationTarget;
    /** Backward-compatible flat routing fields */
    channelId?: string;
    channel?: string;
    /** Plugin runtime for direct API access (avoids CLI subprocess timeouts) */
    runtime?: PluginRuntime;
    /** Optional account ID for multi-account setups */
    accountId?: string;
    /** Injected runCommand for dependency injection. */
    runCommand?: RunCommand;
    /** Optional Telegram forum topic ID for per-topic routing */
    messageThreadId?: number;
    /** Stored delivery target from outbox — skips re-resolution (used by retry path) */
    deliveryTargetOverride?: {
      channelId: string;
      channel?: string;
      accountId?: string;
      messageThreadId?: number;
    };
  },
): Promise<boolean> {
  if (opts.config?.[event.type] === false) return true;

  const message = buildMessage(event);
  const target = opts.deliveryTargetOverride
    ? {
        channelId: opts.deliveryTargetOverride.channelId,
        channel: opts.deliveryTargetOverride.channel ?? "telegram",
        accountId: opts.deliveryTargetOverride.accountId,
        messageThreadId: opts.deliveryTargetOverride.messageThreadId,
      }
    : opts.target ?? (opts.channelId
    ? {
        channelId: opts.channelId,
        channel: opts.channel ?? "telegram",
        accountId: opts.accountId,
        messageThreadId: opts.messageThreadId,
      }
    : undefined);
  const eventId = randomUUID();
  const correlationId = `${event.project}#${event.issueId}`;

  if (!target) {
    await auditLog(opts.workspaceDir, "notify_skip", {
      eventId,
      correlationId,
      eventType: event.type,
      reason: "no target",
    });
    return true; // Not an error, just nothing to do
  }

  // Idempotency: write intent to outbox before sending; skip if duplicate
  const notifyKey = computeNotifyKey(
    (event as any).project ?? "global",
    (event as any).issueId ?? 0,
    event.type,
  );
  const isNew = await writeIntent(opts.workspaceDir, notifyKey, event as Record<string, unknown>, {
    channelId: target.channelId,
    channel: target.channel,
    accountId: target.accountId,
    messageThreadId: target.messageThreadId,
  }).catch(() => false); // FIX: false means "skip on error, retry later"
  if (!isNew) {
    await auditLog(opts.workspaceDir, "notify_skip", {
      eventId,
      correlationId,
      eventType: event.type,
      reason: "duplicate outbox key",
      key: notifyKey,
    }).catch(() => {});
    return true;
  }

  await auditLog(opts.workspaceDir, "notify", {
    eventId,
    correlationId,
    eventType: event.type,
    issue: event.issueId,
    target: target.channelId,
    channel: target.channel,
    accountId: target.accountId ?? null,
    messageThreadId: target.messageThreadId ?? null,
    status: "queued",
    message,
  });

  const sent = await sendMessage(
    target.channelId,
    message,
    target.channel,
    opts.workspaceDir,
    opts.runtime,
    target.accountId,
    opts.runCommand,
    target.messageThreadId,
    {
      eventId,
      correlationId,
      issueId: event.issueId,
      eventType: event.type,
      target,
    },
  );

  if (sent) {
    await markDelivered(opts.workspaceDir, notifyKey).catch(() => {}); // best-effort
  }

  return sent;
}

/**
 * Extract notification config from plugin config.
 * All event types default to enabled (true).
 */
export function getNotificationConfig(
  pluginConfig?: Record<string, unknown>,
): NotificationConfig {
  return (pluginConfig?.notifications as NotificationConfig) ?? {};
}
