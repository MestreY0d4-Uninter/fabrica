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

/** PluginContext — shared services for all Fabrica modules. */
export type PluginContext = {
  runCommand: RunCommand;
  runtime: PluginRuntime;
  pluginConfig: FabricaPluginConfig | undefined;
  config: OpenClawPluginApi["config"];
  sdkLogger: OpenClawPluginApi["logger"];
  logger: FabricaLogger;
  observability: {
    logger(bindings?: Record<string, unknown>): FabricaLogger;
    withContext<T>(bindings: Partial<CorrelationContext>, fn: () => T): T;
    withSpan<T>(name: string, bindings: Partial<CorrelationContext> & Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
  };
};

export function isCliMetadataRuntime(api: OpenClawPluginApi): boolean {
  return (api as OpenClawPluginApi & { registrationMode?: string }).registrationMode === "cli-metadata";
}

function getRuntimeRunCommand(api: OpenClawPluginApi): RunCommand {
  if (isCliMetadataRuntime(api)) {
    return (async () => {
      throw new Error("Fabrica runtime-dependent CLI operation is unavailable during metadata registration");
    }) as RunCommand;
  }

  if (!api.runtime?.system) {
    throw new Error("Fabrica requires a complete OpenClaw runtime outside CLI metadata registration");
  }
  return api.runtime.system.runCommandWithTimeout;
}

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

  const runtime = api.runtime;
  const runCommand = getRuntimeRunCommand(api);

  return {
    runCommand,
    runtime,
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
