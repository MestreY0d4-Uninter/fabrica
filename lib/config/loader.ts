/**
 * config/loader.ts — Three-layer config loading.
 *
 * Resolution order:
 *   1. Built-in defaults (ROLE_REGISTRY + DEFAULT_WORKFLOW)
 *   2. Workspace: <workspace>/fabrica/workflow.yaml
 *   3. Project:   <workspace>/fabrica/projects/<project>/workflow.yaml
 *
 * Also supports legacy config.yaml and workflow.json for backward compat.
 */
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { ROLE_REGISTRY } from "../roles/registry.js";
import { DEFAULT_WORKFLOW, type WorkflowConfig } from "../workflow/index.js";
import { mergeConfig, mergeConfigWithTrace, type MergeTrace } from "./merge.js";
import type { FabricaConfig, ResolvedConfig, ResolvedRoleConfig, ResolvedTimeouts, RoleOverride, ModelEntry } from "./types.js";
import { validateConfig, validateWorkflowIntegrity } from "./schema.js";
import { DATA_DIR, migrateWorkspaceLayout } from "../setup/migrate-layout.js";
import { buildWorkflowResolutionMeta, normalizeWorkflowSemantics } from "./workflow-policy.js";

/**
 * Load and resolve the full Fabrica config for a project.
 *
 * Merges: built-in → workspace workflow.yaml → project workflow.yaml.
 */
export async function loadConfig(
  workspaceDir: string,
  projectName?: string,
): Promise<ResolvedConfig> {
  await migrateWorkspaceLayout(workspaceDir);
  const dataDir = path.join(workspaceDir, DATA_DIR);
  const projectsDir = path.join(dataDir, "projects");
  const sourceLayers = ["built-in"];

  // Layer 1: built-in defaults
  const builtIn = buildDefaultConfig();

  // Layer 2: workspace workflow.yaml (in fabrica/ data dir)
  let merged = builtIn;
  let configTrace: MergeTrace = {};
  const workspaceConfig =
    await readWorkflowFile(dataDir) ??
    await readLegacyConfigFile(path.join(workspaceDir, "projects"));
  if (workspaceConfig) {
    const { merged: m1, trace: t1 } = mergeConfigWithTrace(merged, workspaceConfig, "built-in", "workspace");
    merged = m1;
    configTrace = { ...configTrace, ...t1 };
    sourceLayers.push("workspace");
  }

  // Legacy: standalone workflow.json (only if no workflow section found)
  if (!workspaceConfig?.workflow) {
    const legacyWorkflow = await readLegacyWorkflowJson(projectsDir);
    if (legacyWorkflow) {
      const { merged: m2, trace: t2 } = mergeConfigWithTrace(
        merged,
        { workflow: legacyWorkflow },
        "built-in",
        "workspace:legacy-workflow-json",
      );
      merged = m2;
      configTrace = { ...configTrace, ...t2 };
      sourceLayers.push("workspace:legacy-workflow-json");
    }
  }

  // Layer 3: project workflow.yaml
  if (projectName) {
    const projectDir = path.join(projectsDir, projectName);
    const projectConfig =
      await readWorkflowFile(projectDir) ??
      await readLegacyConfigFile(projectDir);
    if (projectConfig) {
      const prevLabel = sourceLayers[sourceLayers.length - 1] ?? "built-in";
      const { merged: m3, trace: t3 } = mergeConfigWithTrace(
        merged,
        projectConfig,
        prevLabel,
        `project:${projectName}`,
      );
      merged = m3;
      configTrace = { ...configTrace, ...t3 };
      sourceLayers.push(`project:${projectName}`);
    }

    if (!projectConfig?.workflow) {
      const legacyWorkflow = await readLegacyWorkflowJson(projectDir);
      if (legacyWorkflow) {
        const prevLabel2 = sourceLayers[sourceLayers.length - 1] ?? "built-in";
        const { merged: m4, trace: t4 } = mergeConfigWithTrace(
          merged,
          { workflow: legacyWorkflow },
          prevLabel2,
          `project:${projectName}:legacy-workflow-json`,
        );
        merged = m4;
        configTrace = { ...configTrace, ...t4 };
        sourceLayers.push(`project:${projectName}:legacy-workflow-json`);
      }
    }
  }

  return resolve(merged, sourceLayers, configTrace);
}

/**
 * Build the default config from the built-in ROLE_REGISTRY and DEFAULT_WORKFLOW.
 */
function buildDefaultConfig(): FabricaConfig {
  const roles: Record<string, RoleOverride> = {};
  for (const [id, reg] of Object.entries(ROLE_REGISTRY)) {
    roles[id] = {
      levels: [...reg.levels],
      defaultLevel: reg.defaultLevel,
      models: { ...reg.models },
      emoji: { ...reg.emoji },
      completionResults: [...reg.completionResults],
    };
  }
  return { roles, workflow: DEFAULT_WORKFLOW };
}

/**
 * Resolve a merged FabricaConfig into a fully-typed ResolvedConfig.
 */
/** Default max workers per level when no override is set. */
const DEFAULT_MAX_WORKERS_PER_LEVEL = 2;

/** Flatten a ModelEntry map to string-only model IDs. */
function flattenModels(entries: Record<string, ModelEntry>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [level, entry] of Object.entries(entries)) {
    flat[level] = typeof entry === "string" ? entry : entry.model;
  }
  return flat;
}

/** Resolve per-level maxWorkers from model entries + global default. */
function resolveLevelMaxWorkers(
  models: Record<string, ModelEntry>,
  globalDefault: number,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [level, entry] of Object.entries(models)) {
    if (typeof entry === "object" && entry.maxWorkers !== undefined) {
      result[level] = entry.maxWorkers;
    } else {
      result[level] = globalDefault;
    }
  }
  return result;
}

function resolve(config: FabricaConfig, sourceLayers: string[], trace?: MergeTrace): ResolvedConfig {
  const roles: Record<string, ResolvedRoleConfig> = {};
  const globalMaxWorkers = config.workflow?.maxWorkersPerLevel ?? DEFAULT_MAX_WORKERS_PER_LEVEL;

  if (config.roles) {
    for (const [id, override] of Object.entries(config.roles)) {
      if (override === false) {
        // Disabled role — include with enabled: false for visibility
        const reg = ROLE_REGISTRY[id];
        const models: Record<string, ModelEntry> = reg ? { ...reg.models } : {};
        roles[id] = {
          levelMaxWorkers: resolveLevelMaxWorkers(models, globalMaxWorkers),
          levels: reg ? [...reg.levels] : [],
          defaultLevel: reg?.defaultLevel ?? "",
          models: flattenModels(models),
          emoji: reg ? { ...reg.emoji } : {},
          completionResults: reg ? [...reg.completionResults] : [],
          enabled: false,
        };
        continue;
      }

      const reg = ROLE_REGISTRY[id];
      const mergedModels: Record<string, ModelEntry> = {
        ...(reg?.models ?? {}),
        ...(override.models ?? {}),
      };
      roles[id] = {
        levelMaxWorkers: resolveLevelMaxWorkers(mergedModels, globalMaxWorkers),
        levels: override.levels ?? (reg ? [...reg.levels] : []),
        defaultLevel: override.defaultLevel ?? reg?.defaultLevel ?? "",
        models: flattenModels(mergedModels),
        emoji: { ...(reg?.emoji ?? {}), ...(override.emoji ?? {}) },
        completionResults: override.completionResults ?? (reg ? [...reg.completionResults] : []),
        enabled: true,
      };
    }
  }

  // Ensure all built-in roles exist even if not in config
  for (const [id, reg] of Object.entries(ROLE_REGISTRY)) {
    if (!roles[id]) {
      const models: Record<string, ModelEntry> = { ...reg.models };
      roles[id] = {
        levelMaxWorkers: resolveLevelMaxWorkers(models, globalMaxWorkers),
        levels: [...reg.levels],
        defaultLevel: reg.defaultLevel,
        models: flattenModels(models),
        emoji: { ...reg.emoji },
        completionResults: [...reg.completionResults],
        enabled: true,
      };
    }
  }

  const workflowBase: WorkflowConfig = {
    initial: config.workflow?.initial ?? DEFAULT_WORKFLOW.initial,
    reviewPolicy: config.workflow?.reviewPolicy ?? DEFAULT_WORKFLOW.reviewPolicy,
    testPolicy: config.workflow?.testPolicy ?? DEFAULT_WORKFLOW.testPolicy,
    roleExecution: config.workflow?.roleExecution ?? DEFAULT_WORKFLOW.roleExecution,
    states: config.workflow?.states ?? DEFAULT_WORKFLOW.states,
  };
  const { workflow, fixes } = normalizeWorkflowSemantics(workflowBase);

  // Validate structural integrity (cross-references between states)
  const integrityErrors = validateWorkflowIntegrity(workflow);
  if (integrityErrors.length > 0) {
    throw new Error(`Workflow config integrity errors:\n  - ${integrityErrors.join("\n  - ")}`);
  }

  const timeouts: ResolvedTimeouts = {
    gitPullMs: config.timeouts?.gitPullMs ?? 30_000,
    gatewayMs: config.timeouts?.gatewayMs ?? 15_000,
    sessionPatchMs: config.timeouts?.sessionPatchMs ?? 30_000,
    dispatchMs: config.timeouts?.dispatchMs ?? 600_000,
    staleWorkerHours: config.timeouts?.staleWorkerHours ?? 2,
    sessionContextBudget: config.timeouts?.sessionContextBudget ?? 0.6,
    stallTimeoutMinutes: config.timeouts?.stallTimeoutMinutes ?? 15,
    sessionConfirmAttempts: config.timeouts?.sessionConfirmAttempts ?? 5,
    sessionConfirmDelayMs: config.timeouts?.sessionConfirmDelayMs ?? 250,
    sessionLabelMaxLength: config.timeouts?.sessionLabelMaxLength ?? 64,
    auditLogMaxLines: config.timeouts?.auditLogMaxLines ?? 500,
    auditLogMaxBackups: config.timeouts?.auditLogMaxBackups ?? 3,
    lockStaleMs: config.timeouts?.lockStaleMs ?? 30_000,
    healthGracePeriodMs: config.timeouts?.healthGracePeriodMs ?? 900_000,
    dispatchConfirmTimeoutMs: config.timeouts?.dispatchConfirmTimeoutMs ?? 120_000,
    tickTimeoutMs: config.timeouts?.tickTimeoutMs ?? 50_000,
  };

  return {
    roles, workflow, timeouts,
    workflowMeta: buildWorkflowResolutionMeta(workflow, sourceLayers, fixes),
    instanceName: config.instance?.name,
    ...(trace && Object.keys(trace).length > 0 ? { _trace: trace } : {}),
  };
}

// ---------------------------------------------------------------------------
// File reading helpers
// ---------------------------------------------------------------------------

/** Read workflow.yaml (new primary config file). Validates structure via Zod. */
async function readWorkflowFile(dir: string): Promise<FabricaConfig | null> {
  const filePath = path.join(dir, "workflow.yaml");
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = YAML.parse(content);
    if (parsed) validateConfig(parsed);
    return parsed as FabricaConfig;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw new Error(formatConfigReadError(filePath, err, "workflow.yaml"));
  }
}

/** Read config.yaml (old name, fallback for unmigrated workspaces). */
async function readLegacyConfigFile(dir: string): Promise<FabricaConfig | null> {
  const filePath = path.join(dir, "config.yaml");
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = YAML.parse(content);
    if (parsed) validateConfig(parsed);
    return parsed as FabricaConfig;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw new Error(formatConfigReadError(filePath, err, "legacy config.yaml"));
  }
}

/** Read legacy workflow.json (standalone workflow section only). */
async function readLegacyWorkflowJson(dir: string): Promise<Partial<WorkflowConfig> | null> {
  const filePath = path.join(dir, "workflow.json");
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content) as
      | Partial<WorkflowConfig>
      | { workflow?: Partial<WorkflowConfig> };
    const workflow = (parsed as any).workflow ?? parsed;
    if (workflow && typeof workflow === "object") {
      validateConfig({ workflow });
    }
    return workflow;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw new Error(formatConfigReadError(filePath, err, "legacy workflow.json"));
  }
}

function formatConfigReadError(filePath: string, err: unknown, kind: string): string {
  const error = err instanceof Error ? err : new Error(String(err));
  const message = error.message || String(err);
  const invalidKinds = new Set(["ZodError", "YAMLParseError", "SyntaxError"]);
  const prefix = invalidKinds.has((err as { name?: string })?.name ?? "")
    ? `Invalid ${kind}`
    : `Failed to read ${kind}`;
  return `${prefix} at ${filePath}: ${message}`;
}
