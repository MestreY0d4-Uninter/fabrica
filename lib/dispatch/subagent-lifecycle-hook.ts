/**
 * subagent-lifecycle-hook.ts — Register a subagent_ended hook for immediate post-worker cleanup.
 *
 * On every worker subagent end:
 *   1. Filters to Fabrica worker session keys only (project-role-level-name pattern).
 *   2. Writes an audit log entry with sessionKey, project, role, and outcome.
 *   3. Deactivates the worker slot so it can be reused immediately (no 2h stale_worker wait).
 *   4. Reverts the issue label from active back to queue if work_finish hasn't already done so.
 *   5. Wakes heartbeat for immediate dispatch of the next pipeline stage.
 *
 * All checks are best-effort: failures are logged silently and never
 * prevent gateway operation.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginContext } from "../context.js";
import { log as auditLog } from "../audit.js";
import { resolveWorkspaceDir } from "./attachment-hook.js";
import { parseFabricaSessionKey } from "./bootstrap-hook.js";
import { clearSpawnTime, getSpawnTime } from "./reactive-dispatch-hook.js";
import { readProjects, deactivateWorker } from "../projects/index.js";
import { loadConfig } from "../config/index.js";
import { getActiveLabel, getRevertLabel } from "../workflow/index.js";
import { createProvider } from "../providers/index.js";
import { wakeHeartbeat } from "../services/heartbeat/wake-bridge.js";

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

    // Consume spawn time (delete after read to prevent unbounded Map growth in long-running gateway).
    const spawnTime = getSpawnTime(sessionKey);
    clearSpawnTime(sessionKey);
    const durationMs = spawnTime != null ? Date.now() - spawnTime : undefined;

    // Log the subagent end event for immediate diagnostic visibility
    await auditLog(workspaceDir, "subagent_ended", {
      sessionKey,
      project: projectName,
      role,
      outcome: event.outcome ?? "unknown",
      ...(durationMs != null ? { durationMs } : {}),
    }).catch(() => {});

    ctx.logger.info(
      `subagent_ended: worker ${role} in "${projectName}" ended with outcome=${event.outcome ?? "unknown"} (session=${sessionKey})`,
    );

    // --- Slot cleanup: deactivate worker slot on session end ---
    try {
      const projects = await readProjects(workspaceDir);

      // Find project by name (parseFabricaSessionKey returns projectName, not slug)
      const projectEntry = Object.entries(projects.projects).find(
        ([, p]) => p.name === projectName,
      );
      if (!projectEntry) return;
      const [projectSlug, project] = projectEntry;

      // Find the active slot with this sessionKey
      const roleWorker = project.workers[role];
      if (!roleWorker) return;

      let foundLevel: string | undefined;
      let foundSlotIndex: number | undefined;
      let foundSlot: typeof roleWorker.levels[string][number] | undefined;

      for (const [level, slots] of Object.entries(roleWorker.levels)) {
        for (let i = 0; i < slots.length; i++) {
          if (slots[i]!.sessionKey === sessionKey && slots[i]!.active) {
            foundLevel = level;
            foundSlotIndex = i;
            foundSlot = slots[i]!;
            break;
          }
        }
        if (foundSlot) break;
      }

      // If not found or already inactive (work_finish already ran): no-op
      if (!foundSlot || foundLevel == null || foundSlotIndex == null) return;

      const issueId = foundSlot.issueId;

      // Deactivate the slot
      await deactivateWorker(workspaceDir, projectSlug, role, {
        level: foundLevel,
        slotIndex: foundSlotIndex,
      });

      // Revert label if it still matches the active label for this role
      if (issueId) {
        try {
          const config = await loadConfig(workspaceDir, projectSlug);
          const activeLabel = getActiveLabel(config.workflow, role);
          const revertLabel = getRevertLabel(config.workflow, role);

          const { provider } = await createProvider({
            repo: project.repo,
            provider: project.provider,
            runCommand: ctx.runCommand,
          });

          const issue = await provider.getIssue(Number(issueId));
          if (issue.labels.includes(activeLabel)) {
            await provider.transitionLabel(Number(issueId), activeLabel, revertLabel);
          }
        } catch {
          // Best-effort label revert — slot is already deactivated
        }
      }

      await auditLog(workspaceDir, "subagent_ended_slot_cleanup", {
        sessionKey, project: projectName, role,
        level: foundLevel, slotIndex: foundSlotIndex, issueId,
        outcome: event.outcome ?? "unknown",
      }).catch(() => {});

      // Wake heartbeat for immediate dispatch of next pipeline stage
      wakeHeartbeat("subagent_ended").catch(() => {});
    } catch (err) {
      // Best-effort — never block gateway operation
      ctx.logger.warn(`subagent_ended_slot_cleanup failed: ${(err as Error).message}`);
    }
  });
}
