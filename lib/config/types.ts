/**
 * config/types.ts — Types for the unified Fabrica configuration.
 *
 * A single workflow.yaml combines roles, models, and workflow.
 * Three-layer resolution: built-in -> workspace -> per-project.
 */
import type { WorkflowConfig } from "../workflow/index.js";
import type { WorkflowResolutionMeta } from "./workflow-policy.js";

/**
 * Role override in workflow.yaml. All fields optional — only override what you need.
 * Set to `false` to disable a role entirely for a project.
 */
/** Model entry: plain string or object with per-level maxWorkers override. */
export type ModelEntry = string | { model: string; maxWorkers?: number };

export type RoleOverride = {
  maxWorkers?: number; // @deprecated — kept for backward compat, ignored by resolver
  levels?: string[];
  defaultLevel?: string;
  models?: Record<string, ModelEntry>;
  emoji?: Record<string, string>;
  completionResults?: string[];
};

/**
 * Configurable timeout values (in milliseconds).
 * All fields optional — defaults applied at resolution time.
 */
export type TimeoutConfig = {
  gitPullMs?: number;
  gatewayMs?: number;
  sessionPatchMs?: number;
  dispatchMs?: number;
  staleWorkerHours?: number;
  /** Context budget ratio (0-1). Clear session when context exceeds this fraction of the context window. Default: 0.6 */
  sessionContextBudget?: number;
  /** Minutes of session inactivity before stall detection kicks in. Default: 15 */
  stallTimeoutMinutes?: number;
  /** Number of attempts to confirm session creation via gateway. Default: 5 */
  sessionConfirmAttempts?: number;
  /** Delay between session confirmation attempts in ms. Default: 250 */
  sessionConfirmDelayMs?: number;
  /** Maximum length for gateway session labels (truncated beyond this). Default: 64 */
  sessionLabelMaxLength?: number;
  /** Maximum lines to keep in audit.log before rotating. Default: 500 */
  auditLogMaxLines?: number;
  /** Maximum number of audit.log backup files to keep. Default: 3 */
  auditLogMaxBackups?: number;
  /** Milliseconds before a projects.json lock file is considered stale. Default: 30000 */
  lockStaleMs?: number;
  /** Grace period in ms before health checks flag new workers as dead. Default: 900000 (15min) */
  healthGracePeriodMs?: number;
  /** Timeout in ms before unconfirmed dispatches are flagged. Default: 120000 (2min) */
  dispatchConfirmTimeoutMs?: number;
  /** Timeout in ms for a single heartbeat tick. Default: 50000 (50s) */
  tickTimeoutMs?: number;
};

/**
 * Instance identity config. Optional — auto-generated if not set.
 */
export type InstanceConfig = {
  /** Override the auto-generated instance name (CS pioneer name). */
  name?: string;
};

export type GitHubAppProfileConfig = {
  mode?: "github-app";
  appId?: string;
  appIdEnv?: string;
  privateKey?: string;
  privateKeyEnv?: string;
  privateKeyPath?: string;
  privateKeyPathEnv?: string;
  baseUrl?: string;
  fallbackMode?: "pr-conversation-comment";
  allowUserAuthFallback?: boolean;
};

export type ProvidersConfig = {
  github?: {
    defaultAuthProfile?: string;
    authProfiles?: Record<string, GitHubAppProfileConfig>;
    webhookPath?: string;
    webhookSecret?: string;
    webhookSecretPath?: string;
    webhookSecretEnv?: string;
  };
};

/**
 * The full workflow.yaml shape.
 * All fields optional — missing fields inherit from the layer below.
 */
export type FabricaConfig = {
  roles?: Record<string, RoleOverride | false>;
  workflow?: Partial<WorkflowConfig>;
  timeouts?: TimeoutConfig;
  instance?: InstanceConfig;
  providers?: ProvidersConfig;
};

/**
 * Fully resolved timeout config — all fields present with defaults.
 */
export type ResolvedTimeouts = {
  gitPullMs: number;
  gatewayMs: number;
  sessionPatchMs: number;
  dispatchMs: number;
  staleWorkerHours: number;
  /** Context budget ratio (0-1). Clear session when context exceeds this fraction of the context window. Default: 0.6 */
  sessionContextBudget: number;
  /** Minutes of session inactivity before stall detection kicks in. Default: 15 */
  stallTimeoutMinutes: number;
  /** Number of attempts to confirm session creation via gateway. Default: 5 */
  sessionConfirmAttempts: number;
  /** Delay between session confirmation attempts in ms. Default: 250 */
  sessionConfirmDelayMs: number;
  /** Maximum length for gateway session labels (truncated beyond this). Default: 64 */
  sessionLabelMaxLength: number;
  /** Maximum lines to keep in audit.log before rotating. Default: 500 */
  auditLogMaxLines: number;
  /** Maximum number of audit.log backup files to keep. Default: 3 */
  auditLogMaxBackups: number;
  /** Milliseconds before a projects.json lock file is considered stale. Default: 30000 */
  lockStaleMs: number;
  /** Grace period in ms before health checks flag new workers as dead. Default: 900000 (15min) */
  healthGracePeriodMs: number;
  /** Timeout in ms before unconfirmed dispatches are flagged. Default: 120000 (2min) */
  dispatchConfirmTimeoutMs: number;
  /** Timeout in ms for a single heartbeat tick. Default: 50000 (50s) */
  tickTimeoutMs: number;
};

/**
 * Fully resolved config — all fields guaranteed present.
 * Built by merging three layers over the built-in defaults.
 */
export type ResolvedConfig = {
  roles: Record<string, ResolvedRoleConfig>;
  workflow: WorkflowConfig;
  workflowMeta: WorkflowResolutionMeta;
  timeouts: ResolvedTimeouts;
  /** Instance name override from config. Undefined = use auto-generated from instance.json. */
  instanceName?: string;
};

/**
 * Fully resolved role config — all fields present.
 */
export type ResolvedRoleConfig = {
  /** Per-level max workers. Resolved from: per-model maxWorkers → workflow maxWorkersPerLevel → default 2. */
  levelMaxWorkers: Record<string, number>;
  levels: string[];
  defaultLevel: string;
  /** Flattened model map (string IDs only, for existing consumers). */
  models: Record<string, string>;
  emoji: Record<string, string>;
  completionResults: string[];
  enabled: boolean;
};
