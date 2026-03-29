/**
 * model-resolve-hook.ts — Register a before_model_resolve hook for dynamic effort escalation.
 *
 * On every agent run within a Fabrica worker session:
 *   1. Filters to Fabrica worker session keys only (project-role-level-name pattern).
 *   2. Reads the runtime state for the matched slot from projects.json.
 *   3. If lastFailureReason is "complexity", escalates the model to the next level.
 *
 * The escalation overrides the model for this run only — projects.json is not modified.
 * All checks are best-effort: failures are silently ignored and never block model resolution.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginContext } from "../context.js";
import { parseFabricaSessionKey } from "./bootstrap-hook.js";
import { resolveWorkspaceDir } from "./attachment-hook.js";
import { DATA_DIR } from "../setup/constants.js";
import { ROLE_REGISTRY } from "../roles/registry.js";
import { getSessionKeyRolePattern } from "../roles/index.js";
import * as fs from "node:fs";
import * as path from "node:path";

const ESCALATION_MAP: Record<string, string> = {
  junior: "medior",
  medior: "senior",
};

/**
 * Extract the level segment from a Fabrica worker session key.
 *
 * Session key format: `agent:{agentId}:subagent:{projectName}-{role}-{level}-{name}`
 * Returns undefined for legacy or non-worker keys.
 */
function extractLevelFromSessionKey(sessionKey: string, role: string): string | undefined {
  const rolePattern = getSessionKeyRolePattern();
  // Named/numeric format: ...-{role}-{level}-{nameOrIndex}
  const match = sessionKey.match(
    new RegExp(`:subagent:.+-(${rolePattern})-([^-]+)-[^-]+$`),
  );
  if (!match) return undefined;
  return match[2];
}

export function registerModelResolveHook(api: OpenClawPluginApi, ctx: PluginContext): void {
  const workspaceDir = resolveWorkspaceDir(ctx.config as unknown as Record<string, unknown>);
  if (!workspaceDir) return;

  api.on("before_model_resolve", async (event, eventCtx) => {
    const sessionKey = eventCtx.sessionKey;
    if (!sessionKey) return;

    const parsed = parseFabricaSessionKey(sessionKey);
    if (!parsed) return;

    const { projectName, role } = parsed;
    const level = extractLevelFromSessionKey(sessionKey, role);
    if (!level) return;

    // Read runtime state for this issue to check lastFailureReason
    try {
      const projectsPath = path.join(workspaceDir, DATA_DIR, "projects.json");
      const raw = await fs.promises.readFile(projectsPath, "utf-8");
      const projects = JSON.parse(raw);

      const project = Object.values(projects).find((p: any) => p.slug === projectName) as any;
      if (!project?.workers?.[role]?.levels?.[level]) return;

      const slots = project.workers[role].levels[level];
      const slot = slots.find((s: any) => s.sessionKey === sessionKey);
      if (!slot?.runtimeState?.lastFailureReason) return;

      if (slot.runtimeState.lastFailureReason === "complexity") {
        const escalatedLevel = ESCALATION_MAP[level];
        if (!escalatedLevel) return; // already at highest level

        const roleConfig = ROLE_REGISTRY[role];
        if (!roleConfig?.models?.[escalatedLevel]) return;

        ctx.logger.info(
          `before_model_resolve: escalating ${role}/${level} → ${escalatedLevel} model for "${projectName}" (session=${sessionKey})`,
        );

        return {
          modelOverride: roleConfig.models[escalatedLevel],
        };
      }
    } catch {
      // Best-effort — don't block model resolution
    }
  });
}
