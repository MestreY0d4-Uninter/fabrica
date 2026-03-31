/**
 * context.ts — Lightweight DI container for the Fabrica plugin.
 *
 * Created once in register() and threaded to all tools, services, and hooks.
 */
import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk";
import type { FabricaLogger } from "./observability/logger.js";
import { getLogger } from "./observability/logger.js";
import { withCorrelationContext, type CorrelationContext } from "./observability/context.js";
import { withTelemetrySpan } from "./observability/telemetry.js";
import { FabricaPluginConfigSchema } from "./config/schema.js";
import type { FabricaPluginConfig } from "./config/types.js";

/**
 * RunCommand — the signature of api.runtime.system.runCommandWithTimeout.
 * Extracted so consumers don't need the full OpenClawPluginApi type.
 */
export type RunCommand = OpenClawPluginApi["runtime"]["system"]["runCommandWithTimeout"];

/**
 * PluginContext — shared services for all Fabrica modules.
 *
 * No framework, no decorators — just a plain object created once and
 * passed through factory functions and service registrations.
 */
export type PluginContext = {
  /** Run an external command via the plugin SDK (replaces global singleton). */
  runCommand: RunCommand;
  /** Plugin runtime for direct API access (channel messaging, gateway calls). */
  runtime: PluginRuntime;
  /** Plugin-level config from openclaw.json (notifications, heartbeat, etc.). */
  pluginConfig: FabricaPluginConfig | undefined;
  /** Full OpenClaw config (agents list, defaults, etc.) — read-only. */
  config: OpenClawPluginApi["config"];
  /** Structured logger from the plugin SDK. */
  sdkLogger: OpenClawPluginApi["logger"];
  /** Fabrica runtime logger (Pino + correlation context). */
  logger: FabricaLogger;
  /** Correlation + tracing facade for critical flows. */
  observability: {
    logger(bindings?: Record<string, unknown>): FabricaLogger;
    withContext<T>(bindings: Partial<CorrelationContext>, fn: () => T): T;
    withSpan<T>(
      name: string,
      bindings: Partial<CorrelationContext> & Record<string, unknown>,
      fn: () => Promise<T>,
    ): Promise<T>;
  };
};

/**
 * Build a PluginContext from the raw plugin API. Called once in register().
 */
export function createPluginContext(api: OpenClawPluginApi): PluginContext {
  const logger = getLogger({ plugin: "fabrica" });

  // Validate pluginConfig at init time — fail closed for invalid control-plane settings.
  const rawConfig = api.pluginConfig as Record<string, unknown> | undefined;
  if (rawConfig && Object.keys(rawConfig).length > 0) {
    const result = FabricaPluginConfigSchema.safeParse(rawConfig);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new Error(`pluginConfig validation failed: ${issues.join("; ")}`);
    }
  }

  return {
    runCommand: api.runtime.system.runCommandWithTimeout,
    runtime: api.runtime,
    pluginConfig: api.pluginConfig as FabricaPluginConfig | undefined,
    config: api.config,
    sdkLogger: api.logger,
    logger,
    observability: {
      logger(bindings?: Record<string, unknown>) {
        return bindings ? logger.child(bindings) : logger;
      },
      withContext<T>(bindings: Partial<CorrelationContext>, fn: () => T): T {
        return withCorrelationContext(bindings, fn);
      },
      withSpan<T>(
        name: string,
        bindings: Partial<CorrelationContext> & Record<string, unknown>,
        fn: () => Promise<T>,
      ): Promise<T> {
        return withTelemetrySpan(name, bindings, async () => fn());
      },
    },
  };
}
