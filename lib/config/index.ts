/**
 * config/ — Unified Fabrica configuration.
 *
 * Single workflow.yaml per workspace/project combining roles, models, and workflow.
 */
export type {
  FabricaConfig,
  FabricaPluginConfig,
  RoleOverride,
  ResolvedConfig,
  ResolvedRoleConfig,
  ResolvedTimeouts,
  TelegramPluginConfig,
  TimeoutConfig,
} from "./types.js";

export { loadConfig } from "./loader.js";
export { mergeConfig } from "./merge.js";
export { FabricaPluginConfigSchema, validateConfig, validateWorkflowIntegrity } from "./schema.js";
