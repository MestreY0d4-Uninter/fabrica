/**
 * gateway-lifecycle-hook.ts — Register a gateway_start hook for boot-time health checks.
 *
 * On every gateway boot:
 *   1. Verifies the workspace data directory is accessible.
 *   2. Validates that projects.json is present and parseable.
 *   3. Writes an audit log entry with port and bootTime.
 *
 * All checks are best-effort: failures are logged as warnings and never
 * prevent the gateway from starting.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginContext } from "../context.js";
import { DATA_DIR } from "./constants.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { log as auditLog } from "../audit.js";
import { resolveWorkspaceDir } from "../dispatch/attachment-hook.js";

export function registerGatewayLifecycleHook(
  api: OpenClawPluginApi,
  ctx: PluginContext,
): void {
  const workspaceDir = resolveWorkspaceDir(ctx.config as unknown as Record<string, unknown>);
  if (!workspaceDir) return;

  api.on("gateway_start", async (event) => {
    const bootTime = Date.now();
    const dataPath = path.join(workspaceDir, DATA_DIR);

    // 1. Check workspace data directory exists
    try {
      await fs.access(dataPath);
    } catch {
      await auditLog(workspaceDir, "gateway_start_warning", {
        message: `Workspace data directory missing: ${dataPath}`,
      }).catch(() => {});
      return;
    }

    // 2. Validate projects.json
    const projectsPath = path.join(dataPath, "projects.json");
    try {
      const raw = await fs.readFile(projectsPath, "utf-8");
      JSON.parse(raw);
    } catch (err) {
      await auditLog(workspaceDir, "gateway_start_warning", {
        message: `projects.json invalid or missing: ${projectsPath}`,
        error: String(err),
      }).catch(() => {});
    }

    // 3. Log boot event
    await auditLog(workspaceDir, "gateway_start", {
      port: event.port,
      bootTime: new Date(bootTime).toISOString(),
    }).catch(() => {});
  });
}
