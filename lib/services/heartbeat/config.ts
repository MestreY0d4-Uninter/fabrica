import type { FabricaPluginConfig } from "../../config/types.js";
import type { ResolvedConfig } from "../../config/types.js";

/**
 * Heartbeat configuration types and defaults.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HeartbeatConfig = {
  enabled: boolean;
  intervalSeconds: number;
  maxPickupsPerTick: number;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const HEARTBEAT_DEFAULTS: HeartbeatConfig = {
  enabled: true,
  intervalSeconds: 60,
  maxPickupsPerTick: 4,
};

export const DEFAULT_TICK_TIMEOUT_MS = 50_000;

export function resolveHeartbeatConfig(
  pluginConfig?: FabricaPluginConfig | Record<string, unknown>,
): HeartbeatConfig {
  const raw = (pluginConfig as FabricaPluginConfig | undefined)?.work_heartbeat as
    | Partial<HeartbeatConfig>
    | undefined;
  return { ...HEARTBEAT_DEFAULTS, ...raw };
}

export function resolveTickTimeoutMs(config?: Pick<ResolvedConfig, "timeouts"> | null): number {
  return config?.timeouts?.tickTimeoutMs ?? DEFAULT_TICK_TIMEOUT_MS;
}
