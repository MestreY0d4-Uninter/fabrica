/**
 * Tick runner — main heartbeat loop that processes each project.
 */
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { RunCommand } from "../../context.js";
import path from "node:path";
import { readProjects, getProject, type Project } from "../../projects/index.js";
import { log as auditLog } from "../../audit.js";
import { DATA_DIR } from "../../setup/constants.js";
import { loadInstanceName } from "../../instance.js";
import {
  type SessionLookup,
} from "./health.js";
import { projectTick } from "../tick.js";
import { createProvider } from "../../providers/index.js";
import { loadConfig } from "../../config/index.js";
import { ExecutionMode } from "../../workflow/index.js";
import type { HeartbeatConfig } from "./config.js";
import {
  performHealthPass,
  performReviewPass,
  performReviewSkipPass,
  performTestSkipPass,
  performHoldEscapePass,
  performReviewerPollPass,
} from "./passes.js";
import { runPrDiscoveryPass } from "./pr-discovery.js";
import { checkGenesisHealth } from "./genesis-health.js";
import { withTelemetrySpan as withTickSpan } from "../../observability/tracer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TickResult = {
  totalPickups: number;
  totalHealthFixes: number;
  totalSkipped: number;
  totalReviewTransitions: number;
  totalReviewSkipTransitions: number;
  totalTestSkipTransitions: number;
  totalHoldEscapes: number;
};

export type TickMode = "full" | "repair" | "triage";

const discoveredProjects = new Set<string>();

// ---------------------------------------------------------------------------
// Workflow integrity validation (cached per tick)
// ---------------------------------------------------------------------------

function validateWorkflowIntegrity(workflow: import("../../workflow/index.js").WorkflowConfig): string[] {
  const errors: string[] = [];
  const stateKeys = new Set(Object.keys(workflow.states));

  for (const [stateKey, state] of Object.entries(workflow.states)) {
    if (!state.on) continue;
    for (const [event, transition] of Object.entries(state.on)) {
      const targetKey = typeof transition === "string" ? transition : transition?.target;
      if (targetKey && !stateKeys.has(targetKey)) {
        errors.push(`State "${stateKey}" event "${event}" targets unknown state "${targetKey}"`);
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Tick (Main Heartbeat Loop)
// ---------------------------------------------------------------------------

export async function tick(opts: {
  workspaceDir: string;
  agentId?: string;
  config: HeartbeatConfig;
  pluginConfig?: Record<string, unknown>;
  sessions: SessionLookup | null;
  logger: { info(msg: string): void; warn(msg: string): void };
  runtime?: PluginRuntime;
  runCommand: RunCommand;
  mode?: TickMode;
}): Promise<TickResult> {
  const { workspaceDir, agentId, config, pluginConfig, sessions, runtime, runCommand, mode = "full" } = opts;

  // Load instance name for ownership filtering and auto-claiming
  const resolvedWorkspaceConfig = await loadConfig(workspaceDir);
  const instanceName = await loadInstanceName(workspaceDir, resolvedWorkspaceConfig.instanceName);

  const data = await readProjects(workspaceDir);
  const slugs = Object.keys(data.projects);

  if (slugs.length === 0) {
    return {
      totalPickups: 0,
      totalHealthFixes: 0,
      totalSkipped: 0,
      totalReviewTransitions: 0,
      totalReviewSkipTransitions: 0,
      totalTestSkipTransitions: 0,
      totalHoldEscapes: 0,
    };
  }

  const result: TickResult = {
    totalPickups: 0,
    totalHealthFixes: 0,
    totalSkipped: 0,
    totalReviewTransitions: 0,
    totalReviewSkipTransitions: 0,
    totalTestSkipTransitions: 0,
    totalHoldEscapes: 0,
  };

  const projectExecution =
    (pluginConfig?.projectExecution as string) ?? ExecutionMode.PARALLEL;
  let activeProjects = 0;

  for (const slug of slugs) {
    try {
      const project = data.projects[slug];
      if (!project) continue;
      const discoveryKey = `${workspaceDir}:${slug}`;
      if (!discoveredProjects.has(discoveryKey)) {
        discoveredProjects.add(discoveryKey);
        await auditLog(workspaceDir, "project_discovered_by_heartbeat", {
          projectSlug: slug,
          projectName: project.name,
          provider: project.provider ?? null,
          channelCount: project.channels.length,
        });
      }

      const { provider } = await createProvider({
        repo: project.repo,
        provider: project.provider,
        runCommand,
      });
      const resolvedConfig = await loadConfig(workspaceDir, project.slug);

      // Validate workflow integrity (guard against malformed config crashing the tick)
      const workflowErrors = validateWorkflowIntegrity(resolvedConfig.workflow);
      if (workflowErrors.length > 0) {
        opts.logger.warn(`Workflow integrity errors for project ${slug}: ${workflowErrors.join("; ")}`);
        result.totalSkipped++;
        continue;
      }

      if (mode !== "triage") {
        // Wrap passes in a telemetry span for observability
        await withTickSpan(`heartbeat.project.${slug}`, async () => {
          // Health pass: auto-fix zombies and stale workers
          result.totalHealthFixes += await performHealthPass(
            workspaceDir,
            slug,
            project,
            sessions,
            provider,
            resolvedConfig.timeouts.staleWorkerHours,
            instanceName,
            runCommand,
            resolvedConfig.timeouts.stallTimeoutMinutes,
            agentId,
            resolvedConfig,
            runtime,
          );

          // PR Discovery pass: create FabricaRun records for active worker slots (polling-first)
          await runPrDiscoveryPass({
            workspaceDir,
            projectSlug: slug,
            project,
            provider,
            pluginConfig,
            logger: opts.logger,
          }).catch((err) => {
            opts.logger.warn?.(`PR discovery pass failed for ${slug}: ${(err as Error).message}`);
          });

          // Reviewer poll pass: detect reviewer session decisions without waiting for stale_worker
          result.totalReviewTransitions += await performReviewerPollPass(
            workspaceDir, slug, project, provider, resolvedConfig, runtime,
          );

          // Review pass: transition issues whose PR check condition is met
          result.totalReviewTransitions += await performReviewPass(
            workspaceDir, slug, project, provider, resolvedConfig, pluginConfig, runtime, runCommand,
          );

          // Review skip pass: auto-merge and transition review:skip issues through the review queue
          result.totalReviewSkipTransitions += await performReviewSkipPass(
            workspaceDir, slug, project, provider, resolvedConfig, pluginConfig, runtime, runCommand,
          );

          // Test skip pass: auto-transition test:skip issues through the test queue
          result.totalTestSkipTransitions += await performTestSkipPass(
            workspaceDir, slug, project, provider, resolvedConfig, runCommand,
          );

          // Hold escape pass: close issues stuck in hold states with merged PRs
          result.totalHoldEscapes += await performHoldEscapePass(
            workspaceDir, slug, project, provider, resolvedConfig, pluginConfig, runtime, runCommand,
          );
        });
      }

      if (mode === "repair") continue;

      // Budget check: stop if we've hit the limit
      const remaining = config.maxPickupsPerTick - result.totalPickups;
      if (remaining <= 0) break;

      // Sequential project guard: don't start new projects if one is active
      const isProjectActive = await checkProjectActive(workspaceDir, slug);
      if (
        projectExecution === ExecutionMode.SEQUENTIAL &&
        !isProjectActive &&
        activeProjects >= 1
      ) {
        result.totalSkipped++;
        continue;
      }

      // Tick pass: fill free worker slots
      const tickResult = await projectTick({
        workspaceDir,
        projectSlug: slug,
        agentId,
        pluginConfig,
        maxPickups: remaining,
        instanceName,
        runtime,
        runCommand,
        triggerSource: "heartbeat_periodic",
      });

      result.totalPickups += tickResult.pickups.length;
      result.totalSkipped += tickResult.skipped.length;

      // Notifications now handled by dispatchTask
      if (isProjectActive || tickResult.pickups.length > 0) activeProjects++;
    } catch (err) {
      // Per-project isolation: one failing project doesn't crash the entire tick
      opts.logger.warn(
        `Heartbeat tick failed for project ${slug}: ${(err as Error).message}`,
      );
      result.totalSkipped++;
    }
  }

  // Check genesis agent health (stale bootstrap sessions) — best-effort, once per tick
  await checkGenesisHealth(workspaceDir).catch(() => {});

  await auditLog(workspaceDir, "heartbeat_tick", {
    mode,
    projectsScanned: slugs.length,
    healthFixes: result.totalHealthFixes,
    reviewTransitions: result.totalReviewTransitions,
    reviewSkipTransitions: result.totalReviewSkipTransitions,
    testSkipTransitions: result.totalTestSkipTransitions,
    holdEscapes: result.totalHoldEscapes,
    pickups: result.totalPickups,
    skipped: result.totalSkipped,
  });

  return result;
}

/**
 * Check if a project has any active worker.
 */
export async function checkProjectActive(
  workspaceDir: string,
  slug: string,
): Promise<boolean> {
  const data = await readProjects(workspaceDir);
  const project = getProject(data, slug);
  if (!project) return false;
  return Object.values(project.workers).some((w) =>
    Object.values(w.levels).some(slots => slots.some(s => s.active)),
  );
}
