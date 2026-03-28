/**
 * subagent-lifecycle-hook.ts — Register a subagent_ended hook for immediate post-worker diagnostic.
 *
 * On every worker subagent end:
 *   1. Filters to Fabrica worker session keys only (project-role-level-name pattern).
 *   2. Writes an audit log entry with sessionKey, project, role, and outcome.
 *   3. Notes when a worker ended — foundation for Task 12-13 stall diagnostic integration.
 *
 * All checks are best-effort: failures are logged silently and never
 * prevent gateway operation.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginContext } from "../context.js";
import { log as auditLog } from "../audit.js";
import { resolveWorkspaceDir } from "./attachment-hook.js";
import { parseFabricaSessionKey } from "./bootstrap-hook.js";

export function registerSubagentLifecycleHook(
  api: OpenClawPluginApi,
  ctx: PluginContext,
): void {
  const workspaceDir = resolveWorkspaceDir(ctx.config as unknown as Record<string, unknown>);
  if (!workspaceDir) return;

  api.on("subagent_ended", async (event) => {
    const sessionKey = event.targetSessionKey;
    if (!sessionKey) return;

    // Only handle Fabrica worker subagents (pattern: ...:subagent:<project>-<role>-<level>-<name>)
    const parsed = parseFabricaSessionKey(sessionKey);
    if (!parsed) return;

    const { projectName, role } = parsed;

    // Log the subagent end event for immediate diagnostic visibility
    await auditLog(workspaceDir, "subagent_ended", {
      sessionKey,
      project: projectName,
      role,
      outcome: event.outcome ?? "unknown",
    }).catch(() => {});

    // Note: Task 12-13 will integrate diagnoseStall() here when outcome indicates
    // an incomplete run (i.e. worker ended without calling work_finish).
    ctx.logger.info(
      `subagent_ended: worker ${role} in "${projectName}" ended with outcome=${event.outcome ?? "unknown"} (session=${sessionKey})`,
    );
  });
}
