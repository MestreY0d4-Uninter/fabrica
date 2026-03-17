import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { RunCommand } from "../../context.js";
import { ensureDefaultFiles } from "../../setup/workspace.js";
import { log as auditLog } from "../../audit.js";
import { createProvider } from "../../providers/index.js";
import { readProjects } from "../../projects/index.js";
import { loadConfig } from "../../config/index.js";
import { loadInstanceName } from "../../instance.js";
import { discoverAgents } from "./agent-discovery.js";
import { resolveHeartbeatConfig } from "./config.js";
import { fetchGatewaySessions } from "./health.js";
import { tick as runProjectTick, type TickResult } from "./tick-runner.js";
import { performHealthPass } from "./passes.js";
import { processPendingGitHubEventsForWorkspace } from "../../github/process-events.js";

type SweepLogger = {
  info(msg: string): void;
  warn(msg: string): void;
};

export type SweepAgentSummary = {
  agentId: string;
  workspace: string;
};

export type HeartbeatSweepResult = TickResult & {
  agents: SweepAgentSummary[];
  githubEventsProcessed: number;
  githubEventsFailed: number;
  githubEventsSkipped: number;
};

export type HealthSweepResult = {
  agents: SweepAgentSummary[];
  projectsScanned: number;
  healthFixes: number;
};

type SweepOptions = {
  runtime: PluginRuntime;
  pluginConfig?: Record<string, unknown>;
  runCommand: RunCommand;
  workspaceDir?: string;
  agentId?: string;
  logger?: SweepLogger;
};

const noopLogger: SweepLogger = {
  info() {},
  warn() {},
};

function resolveAgents(
  runtime: PluginRuntime,
  workspaceDir?: string,
  agentId?: string,
): SweepAgentSummary[] {
  if (workspaceDir) {
    return [{ agentId: agentId ?? "main", workspace: workspaceDir }];
  }

  const config = runtime.config.loadConfig() as {
    agents?: {
      list?: Array<{ id: string; workspace?: string }>;
      defaults?: { workspace?: string };
    };
  };

  const discovered = discoverAgents(config);
  if (!agentId) return discovered;
  return discovered.filter((agent) => agent.agentId === agentId);
}

export async function runHeartbeatSweep(opts: SweepOptions): Promise<HeartbeatSweepResult> {
  const logger = opts.logger ?? noopLogger;
  const config = resolveHeartbeatConfig(opts.pluginConfig);
  const agents = resolveAgents(opts.runtime, opts.workspaceDir, opts.agentId);

  const result: HeartbeatSweepResult = {
    agents,
    totalPickups: 0,
    totalHealthFixes: 0,
    totalSkipped: 0,
    totalReviewTransitions: 0,
    totalReviewSkipTransitions: 0,
    totalTestSkipTransitions: 0,
    githubEventsProcessed: 0,
    githubEventsFailed: 0,
    githubEventsSkipped: 0,
  };

  if (!config.enabled || agents.length === 0) return result;

  const refreshedWorkspaces = new Set<string>();
  for (const agent of agents) {
    if (refreshedWorkspaces.has(agent.workspace)) continue;
    refreshedWorkspaces.add(agent.workspace);
    try {
      await ensureDefaultFiles(agent.workspace);
      const githubProcessing = await processPendingGitHubEventsForWorkspace({
        workspaceDir: agent.workspace,
        pluginConfig: opts.pluginConfig,
        logger,
      });
      result.githubEventsProcessed += githubProcessing.processed;
      result.githubEventsFailed += githubProcessing.failed;
      result.githubEventsSkipped += githubProcessing.skipped;
    } catch (err) {
      logger.warn(`Workspace refresh failed for ${agent.workspace}: ${(err as Error).message}`);
    }
  }

  const sessions = await fetchGatewaySessions(undefined, opts.runCommand);

  for (const agent of agents) {
    const agentResult = await runProjectTick({
      workspaceDir: agent.workspace,
      agentId: agent.agentId,
      config,
      pluginConfig: opts.pluginConfig,
      sessions,
      logger,
      runtime: opts.runtime,
      runCommand: opts.runCommand,
      mode: "repair",
    });

    result.totalPickups += agentResult.totalPickups;
    result.totalHealthFixes += agentResult.totalHealthFixes;
    result.totalSkipped += agentResult.totalSkipped;
    result.totalReviewTransitions += agentResult.totalReviewTransitions;
    result.totalReviewSkipTransitions += agentResult.totalReviewSkipTransitions;
    result.totalTestSkipTransitions += agentResult.totalTestSkipTransitions;
  }

  return result;
}

export async function runTriageSweep(opts: SweepOptions): Promise<HeartbeatSweepResult> {
  const logger = opts.logger ?? noopLogger;
  const config = resolveHeartbeatConfig(opts.pluginConfig);
  const agents = resolveAgents(opts.runtime, opts.workspaceDir, opts.agentId);

  const result: HeartbeatSweepResult = {
    agents,
    totalPickups: 0,
    totalHealthFixes: 0,
    totalSkipped: 0,
    totalReviewTransitions: 0,
    totalReviewSkipTransitions: 0,
    totalTestSkipTransitions: 0,
    githubEventsProcessed: 0,
    githubEventsFailed: 0,
    githubEventsSkipped: 0,
  };

  if (!config.enabled || agents.length === 0) return result;

  const sessions = await fetchGatewaySessions(undefined, opts.runCommand);

  for (const agent of agents) {
    try {
      await ensureDefaultFiles(agent.workspace);
    } catch (err) {
      logger.warn(`Workspace refresh failed for ${agent.workspace}: ${(err as Error).message}`);
    }

    const agentResult = await runProjectTick({
      workspaceDir: agent.workspace,
      agentId: agent.agentId,
      config,
      pluginConfig: opts.pluginConfig,
      sessions,
      logger,
      runtime: opts.runtime,
      runCommand: opts.runCommand,
      mode: "triage",
    });

    result.totalPickups += agentResult.totalPickups;
    result.totalHealthFixes += agentResult.totalHealthFixes;
    result.totalSkipped += agentResult.totalSkipped;
    result.totalReviewTransitions += agentResult.totalReviewTransitions;
    result.totalReviewSkipTransitions += agentResult.totalReviewSkipTransitions;
    result.totalTestSkipTransitions += agentResult.totalTestSkipTransitions;
  }

  return result;
}

export async function runHealthSweep(opts: SweepOptions): Promise<HealthSweepResult> {
  const logger = opts.logger ?? noopLogger;
  const agents = resolveAgents(opts.runtime, opts.workspaceDir, opts.agentId);
  const sessions = await fetchGatewaySessions(undefined, opts.runCommand);

  const result: HealthSweepResult = {
    agents,
    projectsScanned: 0,
    healthFixes: 0,
  };

  for (const agent of agents) {
    try {
      await ensureDefaultFiles(agent.workspace);
    } catch (err) {
      logger.warn(`Workspace refresh failed for ${agent.workspace}: ${(err as Error).message}`);
    }

    const resolvedWorkspaceConfig = await loadConfig(agent.workspace);
    const instanceName = await loadInstanceName(
      agent.workspace,
      resolvedWorkspaceConfig.instanceName,
    );
    const data = await readProjects(agent.workspace);
    const slugs = Object.keys(data.projects);
    result.projectsScanned += slugs.length;

    for (const slug of slugs) {
      const project = data.projects[slug];
      if (!project) continue;
      try {
        const { provider } = await createProvider({
          repo: project.repo,
          provider: project.provider,
          runCommand: opts.runCommand,
        });
        const resolvedConfig = await loadConfig(agent.workspace, project.name);
        result.healthFixes += await performHealthPass(
          agent.workspace,
          slug,
          project,
          sessions,
          provider,
          resolvedConfig.timeouts.staleWorkerHours,
          instanceName,
          opts.runCommand,
          resolvedConfig.timeouts.stallTimeoutMinutes,
          agent.agentId,
          resolvedConfig,
        );
      } catch (err) {
        logger.warn(
          `Health sweep failed for project ${slug} in ${agent.workspace}: ${(err as Error).message}`,
        );
      }
    }

    await auditLog(agent.workspace, "heartbeat_health_sweep", {
      projectsScanned: slugs.length,
      healthFixes: result.healthFixes,
      invokedBy: "cli",
    }).catch(() => {});
  }

  return result;
}
