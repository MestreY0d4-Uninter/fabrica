/**
 * projects/types.ts — Type definitions for the projects module.
 */

import type { CanonicalStack } from "../intake/types.js";

// ---------------------------------------------------------------------------
// Per-level worker model — each level gets its own slot array
// ---------------------------------------------------------------------------

/** Slot state. Level is structural (implied by position in the levels map). */
export type SlotState = {
  active: boolean;
  issueId: string | null;
  sessionKey: string | null;
  startTime: string | null;
  /** Plugin-generated identity for the current dispatch cycle in this slot. */
  dispatchCycleId?: string | null;
  /** OpenClaw runId for the current dispatch cycle, when known. */
  dispatchRunId?: string | null;
  previousLabel?: string | null;
  /** Deterministic fun name for this slot (e.g. "Ada", "Grace"). */
  name?: string;
  /** Last issue this slot worked on (preserved on deactivation for feedback cycle detection). */
  lastIssueId?: string | null;
};

/** Per-level worker state: levels map instead of flat slots array. */
export type RoleWorkerState = {
  levels: Record<string, SlotState[]>;
};

export type IssueRuntimeState = {
  dispatchRequestedAt?: string | null;
  lastDispatchCycleId?: string | null;
  dispatchRunId?: string | null;
  sessionPatchedAt?: string | null;
  agentAcceptedAt?: string | null;
  firstWorkerActivityAt?: string | null;
  inconclusiveCompletionAt?: string | null;
  inconclusiveCompletionReason?: string | null;
  sessionCompletedAt?: string | null;
  progressNotifiedAt?: string | null;
  artifactOfRecord?: {
    prNumber: number;
    headSha?: string | null;
    mergedAt: string;
    url?: string | null;
  } | null;
  currentPrNodeId?: string | null;
  currentPrNumber?: number | null;
  currentPrUrl?: string | null;
  currentPrState?: string | null;
  currentPrInstallationId?: number | null;
  currentPrRepositoryId?: number | null;
  currentPrHeadSha?: string | null;
  currentPrSourceBranch?: string | null;
  currentPrIssueTarget?: number | null;
  lastHeadSha?: string | null;
  lastRunId?: string | null;
  lastCheckRunId?: number | null;
  lastGitHubDeliveryId?: string | null;
  lastSessionKey?: string | null;
  bindingSource?: "explicit" | "inferred" | "repaired" | "none";
  bindingConfidence?: "high" | "low";
  followUpPrRequired?: boolean;
  lastRejectedPrNumber?: number | null;
  lastResolvedIssueTarget?: number | null;
  boundAt?: string | null;
  lastConflictDetectedAt?: string | null;
  parentIssueId?: number | null;
  childIssueIds?: number[];
  infraFailCount?: number;
  // Diagnostic-first escalation tracking (v0.2.0)
  dispatchAttemptCount?: number;
  lastDispatchedLevel?: string | null;
  lastFailureReason?: "stall" | "infra" | "complexity" | null;
  lastDiagnosticResult?: string | null;
};

export type ProjectEnvironmentStatus = "pending" | "provisioning" | "ready" | "failed";

export type ProjectEnvironmentState = {
  status: ProjectEnvironmentStatus;
  stack: CanonicalStack | null;
  contractVersion: string | null;
  provisioningStartedAt?: string | null;
  lastProvisionedAt?: string | null;
  lastProvisionError?: string | null;
  nextProvisionRetryAt?: string | null;
};

/**
 * Channel registration: maps a channelId to messaging endpoint with event filters.
 */
export type Channel = {
  channelId: string;
  channel: "telegram" | "whatsapp" | "discord" | "slack";
  name: string; // e.g. "primary", "dev-chat"
  events: string[]; // e.g. ["*"] for all, ["workerComplete"] for filtered
  accountId?: string; // Optional account ID for multi-account setups
  messageThreadId?: number; // Optional Telegram forum topic ID for per-topic routing
};

/**
 * Project configuration in the new project-first schema.
 */
export type Project = {
  slug: string;
  name: string;
  repo: string;
  repoRemote?: string; // Git remote URL (e.g., https://github.com/.../repo.git)
  groupName: string;
  deployUrl: string;
  baseBranch: string;
  deployBranch: string;
  /** Channels registered for this project (notification endpoints). */
  channels: Channel[];
  /** Issue tracker provider type (github or gitlab). Auto-detected at registration, stored for reuse. */
  provider?: "github" | "gitlab";
  /** Optional auth profile for provider-specific capabilities (e.g. GitHub App reviewer identity). */
  providerProfile?: string;
  /** Worker state per role (developer, tester, architect, or custom roles). Shared across all channels. */
  workers: Record<string, RoleWorkerState>;
  /** Runtime state tracked per issue to avoid rediscovering the "current PR" heuristically. */
  issueRuntime?: Record<string, IssueRuntimeState>;
  /** Canonical stack selected for this project, when known. */
  stack?: CanonicalStack | null;
  /** Durable environment provisioning state used for contract-based bootstrap and recovery. */
  environment?: ProjectEnvironmentState | null;
};

/**
 * Legacy Project format (channelId-keyed). Used only during migration.
 */
export type LegacyProject = {
  name: string;
  repo: string;
  groupName: string;
  deployUrl: string;
  baseBranch: string;
  deployBranch: string;
  channel?: string;
  provider?: "github" | "gitlab";
  workers: Record<string, RoleWorkerState>;
};

export type ProjectsData = {
  projects: Record<string, Project>; // Keyed by slug (new schema)
};
