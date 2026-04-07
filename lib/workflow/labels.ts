/**
 * workflow/labels.ts — Label formatting, detection, and routing helpers.
 */
import type { WorkflowConfig, ReviewPolicy, TestPolicy } from "./types.js";
import { ReviewPolicy as RP, TestPolicy as TP } from "./types.js";
import { getLabelColors } from "./queries.js";
import type { IssueProvider } from "../providers/provider.js";

// ---------------------------------------------------------------------------
// Step routing labels
// ---------------------------------------------------------------------------

/** Step routing label values — per-issue overrides for workflow steps. */
export const StepRouting = {
  HUMAN: "human",
  AGENT: "agent",
  SKIP: "skip",
} as const;
export type StepRoutingValue = (typeof StepRouting)[keyof typeof StepRouting];

/** Known step routing labels (created on the provider during project registration). */
export const STEP_ROUTING_LABELS: readonly string[] = [
  "review:human", "review:agent", "review:skip",
  "test:skip",
];

/** Legacy operational labels that must not survive active workflow transitions. */
export const LEGACY_OPERATIONAL_LABELS: readonly string[] = [
  "approved",
] as const;

/**
 * Operational labels used by triage and issue management.
 * Created during project registration so that triage can apply them immediately.
 */
export const OPERATIONAL_LABELS: ReadonlyArray<{ name: string; color: string }> = [
  { name: "priority:critical", color: "B60205" },
  { name: "priority:high",     color: "D93F0B" },
  { name: "priority:medium",   color: "FBCA04" },
  { name: "priority:normal",   color: "0E8A16" },
  { name: "effort:small",      color: "C2E0C6" },
  { name: "effort:medium",     color: "FEF2C0" },
  { name: "effort:large",      color: "F9D0C4" },
  { name: "effort:xlarge",     color: "BFD4F2" },
  { name: "type:feature",      color: "0E8A16" },
  { name: "type:bugfix",       color: "D93F0B" },
  { name: "type:refactor",     color: "FBCA04" },
  { name: "type:research",     color: "0075CA" },
  { name: "type:infra",        color: "5319E7" },
  { name: "needs-human",       color: "d73a4a" },
  { name: "approved",          color: "0e8a16" },
  { name: "decomposition:parent", color: "1d76db" },
  { name: "decomposition:child",  color: "5319e7" },
] as const;

/** Step routing label color. */
export const STEP_ROUTING_COLOR = "#d93f0b";

// ---------------------------------------------------------------------------
// Notify labels — channel routing for notifications
// ---------------------------------------------------------------------------

export const NOTIFY_LABEL_PREFIX = "notify:";
export const NOTIFY_LABEL_COLOR = "#e4e4e4";

/** Build the notify label for a channel endpoint. */
export function getNotifyLabel(channel: string, nameOrIndex: string): string {
  return `${NOTIFY_LABEL_PREFIX}${channel}:${nameOrIndex}`;
}

/**
 * Resolve which channel should receive notifications for an issue.
 * Each issue has at most one notify label.
 * Without an explicit notify label, the first channel remains the default.
 * With an explicit notify label, resolution must be exact; invalid routes fail closed.
 */
export function resolveNotifyChannel(
  issueLabels: string[],
  channels: Array<{ channelId: string; channel: string; name?: string; accountId?: string; messageThreadId?: number }>,
): { channelId: string; channel: string; accountId?: string; messageThreadId?: number } | undefined {
  const notifyLabel = issueLabels.find((l) => l.startsWith(NOTIFY_LABEL_PREFIX));
  if (notifyLabel) {
    const value = notifyLabel.slice(NOTIFY_LABEL_PREFIX.length);
    const colonIdx = value.indexOf(":");
    if (colonIdx !== -1) {
      const channelType = value.slice(0, colonIdx);
      const channelName = value.slice(colonIdx + 1);
      return channels.find(
        (ch) => ch.channel === channelType && (ch.name === channelName || String(channels.indexOf(ch)) === channelName),
      );
    }
    return channels.find((ch) => ch.channelId === value);
  }
  return channels[0];
}

// ---------------------------------------------------------------------------
// Owner labels — instance identity on issues
// ---------------------------------------------------------------------------

export const OWNER_LABEL_PREFIX = "owner:";
export const OWNER_LABEL_COLOR = "#e4e4e4";

/** Build the owner label for a given instance name. */
export function getOwnerLabel(instanceName: string): string {
  return `${OWNER_LABEL_PREFIX}${instanceName}`;
}

/** Extract the instance name from an issue's labels, or null if unclaimed. */
export function detectOwner(issueLabels: string[]): string | null {
  const label = issueLabels.find((l) => l.startsWith(OWNER_LABEL_PREFIX));
  return label ? label.slice(OWNER_LABEL_PREFIX.length) : null;
}

/** Check if an issue is owned by the given instance or unclaimed. */
export function isOwnedByOrUnclaimed(
  issueLabels: string[],
  instanceName: string,
): boolean {
  const owner = detectOwner(issueLabels);
  return owner === null || owner === instanceName;
}

// ---------------------------------------------------------------------------
// Review routing
// ---------------------------------------------------------------------------

/**
 * Determine review routing label for an issue based on project policy and developer level.
 */
export function resolveReviewRouting(
  policy: ReviewPolicy, _level: string,
): "review:human" | "review:agent" | "review:skip" {
  if (policy === RP.HUMAN) return "review:human";
  if (policy === RP.AGENT) return "review:agent";
  if (policy === RP.SKIP) return "review:skip";
  return "review:human";
}

/**
 * Determine test routing label for an issue based on project policy.
 */
export function resolveTestRouting(
  policy: TestPolicy, _level: string,
): "test:skip" | "test:agent" {
  if (policy === TP.AGENT) return "test:agent";
  return "test:skip";
}

// ---------------------------------------------------------------------------
// Role labels
// ---------------------------------------------------------------------------

/** Default colors per role for role:level labels. */
const ROLE_LABEL_COLORS: Record<string, string> = {
  developer: "#0e8a16",
  tester: "#5319e7",
  architect: "#0075ca",
  reviewer: "#d93f0b",
};

/**
 * Generate all role:level label definitions from resolved config roles.
 */
export function getRoleLabels(
  roles: Record<string, { levels: string[]; enabled?: boolean }>,
): Array<{ name: string; color: string }> {
  const labels: Array<{ name: string; color: string }> = [];
  for (const [roleId, role] of Object.entries(roles)) {
    if (role.enabled === false) continue;
    for (const level of role.levels) {
      labels.push({
        name: `${roleId}:${level}`,
        color: getRoleLabelColor(roleId),
      });
    }
  }
  for (const routingLabel of STEP_ROUTING_LABELS) {
    labels.push({ name: routingLabel, color: STEP_ROUTING_COLOR });
  }
  return labels;
}

/** Get the label color for a role. Falls back to gray for unknown roles. */
export function getRoleLabelColor(role: string): string {
  return ROLE_LABEL_COLORS[role] ?? "#cccccc";
}

/**
 * Attempt label transition with automatic dual-state recovery.
 */
export async function resilientLabelTransition(
  provider: IssueProvider,
  issueId: number,
  from: string,
  to: string,
  log?: (msg: string) => void,
): Promise<{ success: boolean; dualStateResolved: boolean }> {
  try {
    await provider.transitionLabel(issueId, from, to);
    return { success: true, dualStateResolved: false };
  } catch (err) {
    log?.(`Label transition failed (${from} → ${to}), checking for dual state: ${String(err)}`);
    try {
      const issue = await provider.getIssue(issueId);
      const labels = issue?.labels ?? [];
      if (labels.includes(from) && labels.includes(to)) {
        for (let i = 0; i < 2; i++) {
          try {
            await provider.removeLabels(issueId, [from]);
            log?.(`dual_state_recovery: removed ${from} from issue ${issueId} (atomic PUT should have prevented this — investigate)`);
            return { success: true, dualStateResolved: true };
          } catch (retryErr) {
            log?.(`Retry ${i + 1}/2 to remove ${from} failed: ${String(retryErr)}`);
          }
        }
        log?.(`dual_state_unresolved: issue ${issueId} has both ${from} and ${to}`);
      }
    } catch (checkErr) {
      log?.(`Failed to check issue state: ${String(checkErr)}`);
    }
    return { success: false, dualStateResolved: false };
  }
}
