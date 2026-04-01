import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { RunCommand } from "../context.js";
import { log as auditLog } from "../audit.js";
import { notify, getNotificationConfig } from "../dispatch/notify.js";
import {
  deactivateWorker,
  getRoleWorker,
  recordIssueLifecycle,
  type Channel,
  updateIssueRuntime,
} from "../projects/index.js";
import type { IssueProvider } from "../providers/provider.js";
import { resilientLabelTransition, resolveNotifyChannel } from "../workflow/labels.js";
import { getRootLogger } from "../observability/logger.js";

export const INFRA_FAIL_CIRCUIT_BREAKER_THRESHOLD = 2;

export function hasCurrentDispatchAlreadyCompleted(issueRuntime?: {
  dispatchRequestedAt?: string | null;
  sessionCompletedAt?: string | null;
} | null): boolean {
  const completedAt = issueRuntime?.sessionCompletedAt ?? null;
  if (!completedAt) return false;

  const dispatchRequestedAt = issueRuntime?.dispatchRequestedAt ?? null;
  if (!dispatchRequestedAt) return true;

  const completedMs = Date.parse(completedAt);
  const dispatchRequestedMs = Date.parse(dispatchRequestedAt);
  if (Number.isNaN(completedMs) || Number.isNaN(dispatchRequestedMs)) return true;

  return completedMs >= dispatchRequestedMs;
}

export function resolveWorkerSlot(
  roleWorker: ReturnType<typeof getRoleWorker>,
  sessionKey?: string,
): {
  slotIndex: number;
  slotLevel: string;
  issueId: number;
  recovered: boolean;
  dispatchCycleId?: string | null;
  dispatchRunId?: string | null;
} | null {
  for (const [level, slots] of Object.entries(roleWorker.levels)) {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      if (!slot.active || !slot.issueId) continue;
      if (!sessionKey || !slot.sessionKey || slot.sessionKey === sessionKey) {
        return {
          slotIndex: i,
          slotLevel: level,
          issueId: Number(slot.issueId),
          recovered: false,
          dispatchCycleId: slot.dispatchCycleId ?? null,
          dispatchRunId: slot.dispatchRunId ?? null,
        };
      }
    }
  }

  if (!sessionKey) return null;

  for (const [level, slots] of Object.entries(roleWorker.levels)) {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      if (slot.active || !slot.lastIssueId || slot.sessionKey !== sessionKey) continue;
      return {
        slotIndex: i,
        slotLevel: level,
        issueId: Number(slot.lastIssueId),
        recovered: true,
        dispatchCycleId: slot.dispatchCycleId ?? null,
        dispatchRunId: slot.dispatchRunId ?? null,
      };
    }
  }

  return null;
}

export async function applyTesterInfraFailureCompletion(opts: {
  workspaceDir: string;
  projectSlug: string;
  projectName: string;
  repo: string;
  channels: Channel[];
  issueId: number;
  slotLevel: string;
  slotIndex: number;
  provider: IssueProvider;
  runtime?: PluginRuntime;
  pluginConfig?: Record<string, unknown>;
  runCommand: RunCommand;
  summary?: string;
  source: "agent_end" | "work_finish";
  sessionKey?: string | null;
  currentInfraFails?: number;
}): Promise<{ infraFailCount: number; circuitBroken: boolean }> {
  const infraFailCount = opts.currentInfraFails ?? 1;

  await updateIssueRuntime(opts.workspaceDir, opts.projectSlug, opts.issueId, {
    infraFailCount,
  });

  await auditLog(opts.workspaceDir, "infra_failure", {
    project: opts.projectName,
    issue: opts.issueId,
    role: "tester",
    result: "fail_infra",
    summary: opts.summary ?? null,
    infraFailCount,
    source: opts.source,
  }).catch(() => {});

  const notifyConfig = getNotificationConfig(opts.pluginConfig);
  const target = resolveNotifyChannel([], opts.channels);
  const issueUrl = `https://github.com/${opts.repo}/issues/${opts.issueId}`;
  await notify(
    {
      type: "infraFailure",
      project: opts.projectName,
      issueId: opts.issueId,
      issueUrl,
      summary: opts.summary ?? "Infrastructure failure during testing",
      infraFailCount,
    },
    {
      workspaceDir: opts.workspaceDir,
      config: notifyConfig,
      channelId: target?.channelId,
      channel: target?.channel ?? "telegram",
      runtime: opts.runtime,
      accountId: target?.accountId,
      messageThreadId: target?.messageThreadId,
      runCommand: opts.runCommand,
    },
  ).catch((err) => { getRootLogger().warn(`infra_failure notification failed: ${err}`); });

  const circuitBroken = infraFailCount >= INFRA_FAIL_CIRCUIT_BREAKER_THRESHOLD;
  if (circuitBroken) {
    await auditLog(opts.workspaceDir, "infra_failure_circuit_breaker", {
      project: opts.projectName,
      issue: opts.issueId,
      infraFailCount,
      source: opts.source,
    }).catch(() => {});
  }

  await resilientLabelTransition(
    opts.provider,
    opts.issueId,
    "Testing",
    circuitBroken ? "Refining" : "To Test",
  );

  await deactivateWorker(opts.workspaceDir, opts.projectSlug, "tester", {
    level: opts.slotLevel,
    slotIndex: opts.slotIndex,
    issueId: String(opts.issueId),
  });

  await recordIssueLifecycle({
    workspaceDir: opts.workspaceDir,
    slug: opts.projectSlug,
    issueId: opts.issueId,
    stage: "session_completed",
    sessionKey: opts.sessionKey ?? null,
    details: { role: "tester", result: "fail_infra", infraFailCount, source: opts.source },
  }).catch(() => {});

  return { infraFailCount, circuitBroken };
}
