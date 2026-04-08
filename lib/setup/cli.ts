/**
 * cli.ts — CLI registration for `openclaw fabrica setup` and related commands.
 *
 * Commands: setup, doctor, validate, status, channel (register/unlink/list).
 * Uses Commander.js (provided by OpenClaw plugin SDK context).
 */
import type { Command } from "commander";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { PluginContext } from "../context.js";
import { runSetup } from "./index.js";
import { runDoctor } from "./doctor.js";
import { runIssueDoctor, formatIssueDoctor } from "./doctor-run.js";
import { computeMetrics, formatMetrics } from "../observability/metrics.js";
import { runSecurityDoctor } from "./security-doctor.js";
import { getAllDefaultModels, getAllRoleIds, getLevelsForRole } from "../roles/index.js";
import { readProjects, writeProjects, type Channel } from "../projects/index.js";
import { countActiveSlots } from "../projects/slots.js";
import { readFabricaTelegramConfig } from "../telegram/config.js";
import { log as auditLog } from "../audit.js";
import { runHealthSweep, runHeartbeatSweep, runTriageSweep } from "../services/heartbeat/cli-sweeps.js";
import { createGitHubStores } from "../github/store-factory.js";
import {
  processPendingGitHubEventsForWorkspace,
  reconcileGitHubPullRequestForWorkspace,
  replayGitHubDeliveryForWorkspace,
} from "../github/process-events.js";
import { syncGitHubMergeGovernance } from "../github/governance.js";
import { cleanupWorkspace } from "./agent.js";

/**
 * Get the default workspace directory from the OpenClaw config.
 */
function getDefaultWorkspaceDir(runtime: PluginRuntime): string | undefined {
  try {
    const config = runtime.config.loadConfig();
    return (config as any).agents?.defaults?.workspace ?? undefined;
  } catch {
    return undefined;
  }
}

function requireWorkspaceDir(runtime: PluginRuntime, workspaceDir?: string): string {
  const resolved = workspaceDir ?? getDefaultWorkspaceDir(runtime);
  if (!resolved) {
    console.error("Error: workspace directory not found. Use --workspace or configure agent defaults.workspace");
    process.exit(1);
  }
  return resolved;
}

function printDoctorResult(result: Awaited<ReturnType<typeof runDoctor>>, includeFixed: boolean): void {
  for (const check of result.checks) {
    const icon = check.severity === "ok" ? "OK" : check.severity === "warn" ? "WARN" : "ERR";
    console.log(`  [${icon}] ${check.message}${includeFixed && check.fixed ? " (fixed)" : ""}`);
  }

  console.log(`\n  ${result.checks.length} checks: ${result.errors} errors, ${result.warnings} warnings`);
  if (includeFixed && result.fixed > 0) {
    console.log(`  ${result.fixed} issues fixed`);
  }
}

/**
 * Register the `fabrica` CLI command group on a Commander program.
 */
export function registerCli(program: Command, ctx: PluginContext): void {
  const fabrica = program
    .command("fabrica")
    .description("Fabrica de Software — pipeline orchestration tools");

  const setupCmd = fabrica
    .command("setup")
    .description("Bootstrap workspace: create agent, configure models, write workspace files")
    .option("--new-agent <name>", "Create a new agent with this name")
    .option("--agent <id>", "Use an existing agent by ID")
    .option("--workspace <path>", "Direct workspace path");

  // Register dynamic --<role>-<level> options from registry
  const defaults = getAllDefaultModels();
  for (const role of getAllRoleIds()) {
    for (const level of getLevelsForRole(role)) {
      const flag = `--${role}-${level}`;
      setupCmd.option(`${flag} <model>`, `${role.toUpperCase()} ${level} model (default: ${defaults[role]?.[level] ?? "auto"})`);
    }
  }

  setupCmd.action(async (opts) => {
      // Build model overrides from CLI flags dynamically
      const models: Record<string, Record<string, string>> = {};
      for (const role of getAllRoleIds()) {
        const roleModels: Record<string, string> = {};
        for (const level of getLevelsForRole(role)) {
          // camelCase key: "testerJunior" for --tester-junior, "developerMedior" for --developer-medior
          const key = `${role}${level.charAt(0).toUpperCase()}${level.slice(1)}`;
          if (opts[key]) roleModels[level] = opts[key];
        }
        if (Object.keys(roleModels).length > 0) models[role] = roleModels;
      }

      const telegramConfig = readFabricaTelegramConfig(ctx.pluginConfig as Record<string, unknown> | undefined);
      const shouldEnsureGenesis = telegramConfig.bootstrapDmEnabled && Boolean(telegramConfig.projectsForumChatId);

      const result = await runSetup({
        runtime: ctx.runtime,
        newAgentName: opts.newAgent,
        agentId: opts.agent,
        workspacePath: opts.workspace,
        models: Object.keys(models).length > 0 ? models : undefined,
        runCommand: ctx.runCommand,
        ensureGenesis: shouldEnsureGenesis,
        forumGroupId: telegramConfig.projectsForumChatId,
      });

      if (result.agentCreated) {
        console.log(`Agent "${result.agentId}" created`);
      }

      console.log("Models configured:");
      for (const [role, levels] of Object.entries(result.models)) {
        for (const [level, model] of Object.entries(levels)) {
          console.log(`  ${role}.${level}: ${model}`);
        }
      }

      console.log("Files written:");
      for (const file of result.filesWritten) {
        console.log(`  ${file}`);
      }

      if (result.warnings.length > 0) {
        console.log("\nWarnings:");
        for (const w of result.warnings) {
          console.log(`  ${w}`);
        }
      }

      console.log("\nDone! Next steps:");
      if (shouldEnsureGenesis) {
        console.log("  1. Keep the bot reachable in DM");
        console.log("  2. Add the bot to the projects forum group and allow topic creation");
        console.log("  3. Send the project idea to the bot in DM to bootstrap the project automatically");
      } else {
        console.log("  1. Run `openclaw fabrica doctor workspace --workspace <path>` to confirm workspace readiness");
        console.log("  2. If you want the official Telegram DM → topic flow, set plugins.entries.fabrica.config.telegram.projectsForumChatId");
        console.log("  3. You can also export FABRICA_PROJECTS_CHANNEL_ID before running setup to prefill that value automatically");
        console.log("  4. Re-run `openclaw fabrica setup` after the Telegram forum config is in place");
      }
    });

  // Doctor — diagnostic + optional auto-fix
  const doctor = fabrica
    .command("doctor")
    .description("Diagnose workspace integrity and optionally auto-fix issues");

  doctor
    .command("workspace")
    .description("Diagnose workspace integrity and optionally auto-fix issues")
    .option("-w, --workspace <path>", "Workspace directory")
    .option("--fix", "Apply fixes for detected issues")
    .action(async (opts) => {
      const workspaceDir = requireWorkspaceDir(ctx.runtime, opts.workspace);

      const result = await runDoctor({ workspacePath: workspaceDir, fix: opts.fix ?? false, pluginConfig: ctx.pluginConfig as Record<string, unknown> });
      printDoctorResult(result, true);

      if (result.errors > 0 && !opts.fix) {
        console.log("\n  Run with --fix to attempt auto-repair.");
      }

      process.exit(result.errors > 0 ? 1 : 0);
    });

  doctor
    .command("security")
    .description("Run Fabrica-native operational security checks")
    .option("--openclaw-home <path>", "OpenClaw home directory", process.env.OPENCLAW_HOME)
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts) => {
      const openclawHome = opts.openclawHome ?? `${process.env.HOME}/.openclaw`;
      const result = await runSecurityDoctor(openclawHome);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.errors > 0 ? 1 : 0);
      }

      for (const check of result.checks) {
        const icon = check.severity === "ok" ? "OK" : check.severity === "warn" ? "WARN" : "ERR";
        console.log(`  [${icon}] ${check.message}`);
      }
      console.log(`\n  ${result.checks.length} checks: ${result.errors} errors, ${result.warnings} warnings`);
      process.exit(result.errors > 0 ? 1 : 0);
    });

  doctor
    .command("issue")
    .description("Inspect one Fabrica issue/run with convergence and PR context")
    .requiredOption("-p, --project <slug>", "Project slug")
    .requiredOption("-i, --issue <id>", "Issue number")
    .option("-w, --workspace <path>", "Workspace directory")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts) => {
      const workspaceDir = requireWorkspaceDir(ctx.runtime, opts.workspace);
      const issueId = Number.parseInt(String(opts.issue), 10);
      if (!Number.isFinite(issueId)) {
        console.error(`Invalid issue id: ${opts.issue}`);
        process.exit(1);
      }
      const result = await runIssueDoctor({
        workspacePath: workspaceDir,
        projectSlug: String(opts.project),
        issueId,
        runCommand: ctx.runCommand,
        pluginConfig: ctx.pluginConfig as Record<string, unknown>,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(formatIssueDoctor(result));
    });

  doctor
    .option("-w, --workspace <path>", "Workspace directory")
    .option("--fix", "Apply fixes for detected issues")
    .action(async (opts) => {
      const workspaceDir = requireWorkspaceDir(ctx.runtime, opts.workspace);

      const result = await runDoctor({ workspacePath: workspaceDir, fix: opts.fix ?? false, pluginConfig: ctx.pluginConfig as Record<string, unknown> });
      printDoctorResult(result, true);

      if (result.errors > 0 && !opts.fix) {
        console.log("\n  Run with --fix to attempt auto-repair.");
      }

      process.exit(result.errors > 0 ? 1 : 0);
    });

  // Validate — dry-run diagnostic (never fixes)
  fabrica
    .command("validate")
    .description("Validate workspace integrity (read-only, no fixes)")
    .option("-w, --workspace <path>", "Workspace directory")
    .action(async (opts) => {
      const workspaceDir = requireWorkspaceDir(ctx.runtime, opts.workspace);

      const result = await runDoctor({ workspacePath: workspaceDir, fix: false, pluginConfig: ctx.pluginConfig as Record<string, unknown> });
      printDoctorResult(result, false);
      process.exit(result.errors > 0 ? 1 : 0);
    });

  // Metrics — show operational summary from audit log
  fabrica
    .command("metrics")
    .description("Show operational metrics from the Fabrica audit log")
    .option("-w, --workspace <path>", "Workspace directory")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts) => {
      const workspaceDir = requireWorkspaceDir(ctx.runtime, opts.workspace);

      try {
        const metrics = await computeMetrics(workspaceDir);
        if (opts.json) {
          console.log(JSON.stringify(metrics, null, 2));
          return;
        }
        console.log(formatMetrics(metrics));
      } catch (err: any) {
        console.error(`Error computing metrics: ${err.message}`);
        process.exit(1);
      }
    });

  const heartbeat = fabrica
    .command("heartbeat")
    .description("One-shot Fabrica heartbeat commands for operational sweeps");

  const triage = fabrica
    .command("triage")
    .description("Operational triage and pickup commands backed by Fabrica heartbeat");
  const workspace = fabrica
    .command("workspace")
    .description("Workspace maintenance commands backed by Fabrica");
  const github = fabrica
    .command("github")
    .description("GitHub operational helpers for Fabrica");

  heartbeat
    .command("once")
    .description("Run one heartbeat sweep using the same services as the Fabrica runtime")
    .option("-w, --workspace <path>", "Restrict the sweep to a specific workspace")
    .option("-a, --agent <id>", "Restrict the sweep to a specific agent ID")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts) => {
      const result = await runHeartbeatSweep({
        runtime: ctx.runtime,
        pluginConfig: ctx.pluginConfig,
        runCommand: ctx.runCommand,
        workspaceDir: opts.workspace,
        agentId: opts.agent,
        logger: ctx.logger,
      });

      if (result === null) {
        console.warn("Heartbeat sweep skipped: a tick is already running");
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log("Heartbeat sweep complete");
      console.log(`  Agents: ${result.agents.length}`);
      console.log(`  Pickups: ${result.totalPickups}`);
      console.log(`  Health fixes: ${result.totalHealthFixes}`);
      console.log(`  Review transitions: ${result.totalReviewTransitions}`);
      console.log(`  Review skips: ${result.totalReviewSkipTransitions}`);
      console.log(`  Test skips: ${result.totalTestSkipTransitions}`);
      console.log(`  Skipped: ${result.totalSkipped}`);
      console.log(`  GitHub events processed: ${result.githubEventsProcessed}`);
      console.log(`  GitHub events failed: ${result.githubEventsFailed}`);
      console.log(`  GitHub events skipped: ${result.githubEventsSkipped}`);
    });

  triage
    .command("sweep")
    .description("Run one triage/pickup sweep through the Fabrica heartbeat engine")
    .option("-w, --workspace <path>", "Restrict the sweep to a specific workspace")
    .option("-a, --agent <id>", "Restrict the sweep to a specific agent ID")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts) => {
      const result = await runTriageSweep({
        runtime: ctx.runtime,
        pluginConfig: ctx.pluginConfig,
        runCommand: ctx.runCommand,
        workspaceDir: opts.workspace,
        agentId: opts.agent,
        logger: ctx.logger,
      });

      if (result === null) {
        console.warn("Triage sweep skipped: a tick is already running");
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log("Triage sweep complete");
      console.log(`  Agents: ${result.agents.length}`);
      console.log(`  Pickups: ${result.totalPickups}`);
      console.log(`  Health fixes: ${result.totalHealthFixes}`);
      console.log(`  Review transitions: ${result.totalReviewTransitions}`);
      console.log(`  Review skips: ${result.totalReviewSkipTransitions}`);
      console.log(`  Test skips: ${result.totalTestSkipTransitions}`);
      console.log(`  Skipped: ${result.totalSkipped}`);
      console.log(`  GitHub events processed: ${result.githubEventsProcessed}`);
      console.log(`  GitHub events failed: ${result.githubEventsFailed}`);
      console.log(`  GitHub events skipped: ${result.githubEventsSkipped}`);
    });

  workspace
    .command("cleanup")
    .description("Clean workspace bootstrap artifacts managed by Fabrica")
    .option("-w, --workspace <path>", "Workspace directory")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts) => {
      const workspaceDir = requireWorkspaceDir(ctx.runtime, opts.workspace);
      await cleanupWorkspace(workspaceDir);

      if (opts.json) {
        console.log(JSON.stringify({ workspaceDir, cleaned: true }, null, 2));
        return;
      }

      console.log(`Workspace cleanup complete: ${workspaceDir}`);
    });

  github
    .command("events")
    .description("Inspect persisted GitHub webhook events recorded by Fabrica")
    .option("-w, --workspace <path>", "Workspace directory")
    .option("--status <status>", "Filter by event status (pending|processing|success|failed|skipped)")
    .option("--event <name>", "Filter by GitHub event name")
    .option("--pr <number>", "Filter by PR number")
    .option("--dead-letter", "Only show events dead-lettered by the retry policy")
    .option("--limit <n>", "Maximum records to print", "20")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts) => {
      const workspaceDir = requireWorkspaceDir(ctx.runtime, opts.workspace);
      const { eventStore } = await createGitHubStores(workspaceDir, { logger: ctx.logger });
      const store = eventStore;
      const records = await store.listEvents({
        status: opts.status,
        eventName: opts.event,
        prNumber: opts.pr ? Number(opts.pr) : undefined,
        deadLetter: opts.deadLetter ? true : undefined,
        limit: Number(opts.limit),
      });

      if (opts.json) {
        console.log(JSON.stringify(records, null, 2));
        return;
      }

      if (records.length === 0) {
        console.log("No GitHub webhook events recorded.");
        return;
      }

      for (const record of records) {
        console.log(
          [
            record.receivedAt,
            record.status.toUpperCase(),
            record.eventName,
            record.action ?? "-",
            `delivery=${record.deliveryId}`,
            record.prNumber ? `pr=${record.prNumber}` : null,
            record.headSha ? `sha=${record.headSha.slice(0, 12)}` : null,
            `attempt=${record.attemptCount}`,
            record.deadLetter ? "dead-letter" : null,
            record.runId ? `run=${record.runId}` : null,
            record.checkRunId ? `check=${record.checkRunId}` : null,
          ].filter(Boolean).join(" "),
        );
      }
    });

  github
    .command("process-events")
    .description("Process pending persisted GitHub webhook events through the Fabrica repair loop")
    .option("-w, --workspace <path>", "Workspace directory")
    .option("--backend <backend>", "Preferred store backend (sqlite|file)")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts) => {
      const workspaceDir = requireWorkspaceDir(ctx.runtime, opts.workspace);
      const result = await processPendingGitHubEventsForWorkspace({
        workspaceDir,
        pluginConfig: ctx.pluginConfig,
        logger: ctx.logger,
        backend: opts.backend,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log("GitHub event processing complete");
      console.log(`  Backend: ${result.backend}`);
      console.log(`  Pending scanned: ${result.pending}`);
      console.log(`  Processed: ${result.processed}`);
      console.log(`  Skipped: ${result.skipped}`);
      console.log(`  Failed: ${result.failed}`);
      console.log(`  Dead-lettered: ${result.deadLettered}`);
      console.log(`  Quality gate updates: ${result.qualityGateUpdates}`);
    });

  github
    .command("replay")
    .description("Replay one persisted GitHub webhook delivery through Fabrica")
    .requiredOption("--delivery <id>", "GitHub delivery ID to replay")
    .option("-w, --workspace <path>", "Workspace directory")
    .option("--backend <backend>", "Preferred store backend (sqlite|file)")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts) => {
      const workspaceDir = requireWorkspaceDir(ctx.runtime, opts.workspace);
      const result = await replayGitHubDeliveryForWorkspace({
        workspaceDir,
        deliveryId: opts.delivery,
        pluginConfig: ctx.pluginConfig,
        logger: ctx.logger,
        backend: opts.backend,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log("GitHub delivery replay complete");
      console.log(`  Backend: ${result.backend}`);
      console.log(`  Delivery: ${result.deliveryId}`);
      console.log(`  Found: ${result.found ? "yes" : "no"}`);
      console.log(`  Processed: ${result.processed}`);
      console.log(`  Skipped: ${result.skipped}`);
      console.log(`  Failed: ${result.failed}`);
      console.log(`  Dead-lettered: ${result.deadLettered}`);
      console.log(`  Quality gate updates: ${result.qualityGateUpdates}`);
    });

  github
    .command("reconcile-pr")
    .description("Reconcile one PR from persisted GitHub events")
    .requiredOption("--pr <number>", "PR number to reconcile")
    .option("-w, --workspace <path>", "Workspace directory")
    .option("--backend <backend>", "Preferred store backend (sqlite|file)")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts) => {
      const workspaceDir = requireWorkspaceDir(ctx.runtime, opts.workspace);
      const result = await reconcileGitHubPullRequestForWorkspace({
        workspaceDir,
        prNumber: Number(opts.pr),
        pluginConfig: ctx.pluginConfig,
        logger: ctx.logger,
        backend: opts.backend,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log("GitHub PR reconcile complete");
      console.log(`  Backend: ${result.backend}`);
      console.log(`  PR: #${result.prNumber}`);
      console.log(`  Events scanned: ${result.pending}`);
      console.log(`  Processed: ${result.processed}`);
      console.log(`  Skipped: ${result.skipped}`);
      console.log(`  Failed: ${result.failed}`);
      console.log(`  Dead-lettered: ${result.deadLettered}`);
      console.log(`  Quality gate updates: ${result.qualityGateUpdates}`);
    });

  github
    .command("dead-letter")
    .description("Inspect GitHub webhook deliveries moved to dead-letter state")
    .option("-w, --workspace <path>", "Workspace directory")
    .option("--limit <n>", "Maximum records to print", "20")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts) => {
      const workspaceDir = requireWorkspaceDir(ctx.runtime, opts.workspace);
      const { eventStore, backend } = await createGitHubStores(workspaceDir, { logger: ctx.logger });
      const records = await eventStore.listEvents({
        deadLetter: true,
        limit: Number(opts.limit),
      });

      if (opts.json) {
        console.log(JSON.stringify({ backend, records }, null, 2));
        return;
      }

      if (records.length === 0) {
        console.log(`No dead-lettered GitHub webhook events recorded (${backend}).`);
        return;
      }

      console.log(`Dead-lettered GitHub events (${backend})`);
      for (const record of records) {
        console.log(
          [
            record.receivedAt,
            record.eventName,
            record.action ?? "-",
            `delivery=${record.deliveryId}`,
            `attempt=${record.attemptCount}`,
            record.prNumber ? `pr=${record.prNumber}` : null,
            record.error ? `error=${record.error}` : null,
          ].filter(Boolean).join(" "),
        );
      }
    });

  github
    .command("sync-governance")
    .description("Configure Fabrica as the required GitHub quality gate for a repository branch")
    .requiredOption("--owner <owner>", "GitHub repository owner")
    .requiredOption("--repo <repo>", "GitHub repository name")
    .requiredOption("--branch <branch>", "Branch to protect")
    .option("--require-reviews <n>", "Required approving reviews", "1")
    .option("--disable-conversation-resolution", "Do not require resolved conversations")
    .option("--enable-automerge", "Enable repository auto-merge support")
    .option("--enable-merge-queue", "Mark merge-queue preparation in the result")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts) => {
      const result = await syncGitHubMergeGovernance({
        pluginConfig: ctx.pluginConfig,
        owner: opts.owner,
        repo: opts.repo,
        branch: opts.branch,
        requiredApprovingReviewCount: Number(opts.requireReviews),
        requireConversationResolution: !opts.disableConversationResolution,
        enableAutomerge: opts.enableAutomerge === true,
        enableMergeQueue: opts.enableMergeQueue === true,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.attempted ? 0 : 1);
      }

      if (!result.attempted) {
        console.log(`GitHub governance sync skipped: ${result.skippedReason ?? "unknown"}`);
        process.exit(1);
      }

      console.log("GitHub governance sync complete");
      console.log(`  Installation: ${result.installationId ?? "unknown"}`);
      console.log(`  Required check: ${result.requiredCheckConfigured ? "configured" : "not configured"}`);
      console.log(`  Automerge: ${result.automergePrepared ? "prepared" : "unchanged"}`);
      console.log(`  Merge queue: ${result.mergeQueuePrepared ? "operator-prepared" : "unchanged"}`);
    });

  const health = fabrica
    .command("health")
    .description("One-shot Fabrica health sweeps for workers and tracked issues");

  health
    .command("sweep")
    .description("Run only the health auto-fix sweep without queue pickups")
    .option("-w, --workspace <path>", "Restrict the sweep to a specific workspace")
    .option("-a, --agent <id>", "Restrict the sweep to a specific agent ID")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts) => {
      const result = await runHealthSweep({
        runtime: ctx.runtime,
        pluginConfig: ctx.pluginConfig,
        runCommand: ctx.runCommand,
        workspaceDir: opts.workspace,
        agentId: opts.agent,
        logger: ctx.logger,
      });

      if (result === null) {
        console.warn("Health sweep skipped: a tick is already running");
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log("Health sweep complete");
      console.log(`  Agents: ${result.agents.length}`);
      console.log(`  Projects scanned: ${result.projectsScanned}`);
      console.log(`  Health fixes: ${result.healthFixes}`);
    });

  const configCmd = fabrica
    .command("config")
    .description("Stable Fabrica config/workspace validation wrappers");

  configCmd
    .command("validate")
    .description("Validate Fabrica workspace/config (read-only wrapper around doctor)")
    .option("-w, --workspace <path>", "Workspace directory")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts) => {
      const workspaceDir = requireWorkspaceDir(ctx.runtime, opts.workspace);
      const result = await runDoctor({ workspacePath: workspaceDir, fix: false });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.errors > 0 ? 1 : 0);
      }

      printDoctorResult(result, false);
      process.exit(result.errors > 0 ? 1 : 0);
    });

  // Status — operational overview
  fabrica
    .command("status")
    .description("Show operational overview: projects, workers, queues")
    .option("-w, --workspace <path>", "Workspace directory")
    .action(async (opts) => {
      const workspaceDir = requireWorkspaceDir(ctx.runtime, opts.workspace);

      try {
        const data = await readProjects(workspaceDir);
        const projects = Object.entries(data.projects);

        if (projects.length === 0) {
          console.log("No projects registered.");
          return;
        }

        console.log(`\nProjects: ${projects.length}\n`);

        for (const [slug, project] of projects) {
          const channels = project.channels.map(ch => `${ch.channel}:${ch.channelId}`).join(", ");
          console.log(`  ${project.name} (${slug})`);
          console.log(`    Repo: ${project.repo}`);
          console.log(`    Channels: ${channels || "(none)"}`);

          // Worker summary
          const workerRoles = Object.keys(project.workers ?? {});
          if (workerRoles.length > 0) {
            for (const role of workerRoles) {
              const workerState = project.workers[role];
              if (!workerState) continue;
              const active = countActiveSlots(workerState);
              const total = Object.values(workerState.levels).reduce((sum, slots) => sum + slots.length, 0);
              console.log(`    ${role}: ${active}/${total} active`);
            }
          } else {
            console.log("    Workers: (none configured)");
          }
          console.log();
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  // Channel management commands
  const channel = fabrica
    .command("channel")
    .description("Manage project channels (register, deregister, list)");

  // Register (link) a channel to a project
  channel
    .command("register")
    .description("Register/link a channel to a project")
    .requiredOption("-p, --project <name>", "Project name or slug")
    .requiredOption("-c, --channel-id <id>", "Channel ID (e.g., Telegram group ID)")
    .option("-t, --type <type>", "Channel type (telegram, discord, slack, whatsapp)", "telegram")
    .option("-n, --name <name>", "Display name for this channel")
    .option("-w, --workspace <path>", "Workspace directory (defaults to agent defaults.workspace)")
    .action(async (opts) => {
      const workspaceDir = requireWorkspaceDir(ctx.runtime, opts.workspace);

      try {
        const data = await readProjects(workspaceDir);

        // Resolve project
        const slug = opts.project.toLowerCase().replace(/\s+/g, "-");
        const project =
          data.projects[slug] ??
          Object.values(data.projects).find((p) => p.name.toLowerCase() === opts.project.toLowerCase());

        if (!project) {
          const available = Object.values(data.projects).map((p) => p.name).join(", ");
          console.error(
            `Error: Project "${opts.project}" not found. Available: ${available || "none"}`
          );
          process.exit(1);
        }

        // Check if already registered
        const existing = project.channels.find((ch) => ch.channelId === opts.channelId);
        if (existing) {
          console.log(`Channel ${opts.channelId} already registered to project "${project.name}"`);
          return;
        }

        // Auto-detach from other projects
        let detachedFrom: string | null = null;
        for (const p of Object.values(data.projects)) {
          const idx = p.channels.findIndex((ch) => ch.channelId === opts.channelId);
          if (idx !== -1) {
            detachedFrom = p.name;
            p.channels.splice(idx, 1);
            break;
          }
        }

        // Add channel
        const newChannel: Channel = {
          channelId: opts.channelId,
          channel: opts.type as Channel["channel"],
          name: opts.name ?? `channel-${project.channels.length + 1}`,
          events: ["*"],
        };
        project.channels.push(newChannel);

        await writeProjects(workspaceDir, data);
        await auditLog(workspaceDir, "channel_register_cli", {
          project: project.name,
          channelId: opts.channelId,
          channelType: opts.type,
          channelName: newChannel.name,
          detachedFrom,
        });

        const detachNote = detachedFrom ? ` (detached from "${detachedFrom}")` : "";
        console.log(`✓ Channel registered to "${project.name}"${detachNote}`);
        console.log(`  Channel ID: ${opts.channelId}`);
        console.log(`  Channel type: ${opts.type}`);
        console.log(`  Channel name: ${newChannel.name}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  // Unlink a channel from a project
  channel
    .command("unlink")
    .description("Unlink a channel from a project")
    .requiredOption("-p, --project <name>", "Project name or slug")
    .requiredOption("-c, --channel-id <id>", "Channel ID to remove")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("-w, --workspace <path>", "Workspace directory (defaults to agent defaults.workspace)")
    .action(async (opts) => {
      const workspaceDir = requireWorkspaceDir(ctx.runtime, opts.workspace);

      try {
        const data = await readProjects(workspaceDir);

        // Resolve project
        const slug = opts.project.toLowerCase().replace(/\s+/g, "-");
        const project =
          data.projects[slug] ??
          Object.values(data.projects).find((p) => p.name.toLowerCase() === opts.project.toLowerCase());

        if (!project) {
          const available = Object.values(data.projects).map((p) => p.name).join(", ");
          console.error(
            `Error: Project "${opts.project}" not found. Available: ${available || "none"}`
          );
          process.exit(1);
        }

        // Find channel
        const idx = project.channels.findIndex((ch) => ch.channelId === opts.channelId);
        if (idx === -1) {
          console.error(`Error: Channel ${opts.channelId} not found in project "${project.name}"`);
          process.exit(1);
        }

        // Prevent removing last channel
        if (project.channels.length === 1) {
          console.error(
            `Error: Cannot remove the last channel from project "${project.name}". Projects must have at least one channel.`
          );
          process.exit(1);
        }

        const channel = project.channels[idx];

        // Confirmation prompt (unless --yes)
        if (!opts.yes) {
          const readline = await import("node:readline");
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const answer = await new Promise<string>((resolve) => {
            rl.question(
              `Remove channel "${channel.name}" (${channel.channelId}) from project "${project.name}"? [y/N] `,
              resolve
            );
          });
          rl.close();

          if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
            console.log("Cancelled.");
            return;
          }
        }

        // Remove channel
        project.channels.splice(idx, 1);

        await writeProjects(workspaceDir, data);
        await auditLog(workspaceDir, "channel_unlink_cli", {
          project: project.name,
          channelId: opts.channelId,
          channelName: channel.name,
        });

        console.log(`✓ Channel unlinked from "${project.name}"`);
        console.log(`  Removed: ${channel.name} (${opts.channelId})`);
        console.log(`  Remaining channels: ${project.channels.length}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  // List channels for a project (or all projects)
  channel
    .command("list")
    .description("List channels for a project (or all projects)")
    .option("-p, --project <name>", "Project name or slug (omit to list all)")
    .option("-w, --workspace <path>", "Workspace directory (defaults to agent defaults.workspace)")
    .action(async (opts) => {
      const workspaceDir = requireWorkspaceDir(ctx.runtime, opts.workspace);

      try {
        const data = await readProjects(workspaceDir);

        if (opts.project) {
          // Show channels for a specific project
          const slug = opts.project.toLowerCase().replace(/\s+/g, "-");
          const project =
            data.projects[slug] ??
            Object.values(data.projects).find((p) => p.name.toLowerCase() === opts.project.toLowerCase());

          if (!project) {
            const available = Object.values(data.projects).map((p) => p.name).join(", ");
            console.error(
              `Error: Project "${opts.project}" not found. Available: ${available || "none"}`
            );
            process.exit(1);
          }

          console.log(`Channels for project "${project.name}":`);
          if (project.channels.length === 0) {
            console.log("  (none)");
          } else {
            for (const ch of project.channels) {
              console.log(`  • ${ch.name} (${ch.channel})`);
              console.log(`    ID: ${ch.channelId}`);
              console.log(`    Events: ${ch.events.join(", ")}`);
              if (ch.accountId) console.log(`    Account: ${ch.accountId}`);
            }
          }
        } else {
          // Show all channels for all projects
          const projects = Object.values(data.projects);
          if (projects.length === 0) {
            console.log("No projects registered.");
            return;
          }

          for (const project of projects) {
            console.log(`\n${project.name} (${project.slug}):`);
            if (project.channels.length === 0) {
              console.log("  (no channels)");
            } else {
              for (const ch of project.channels) {
                console.log(`  • ${ch.name} (${ch.channel}) — ${ch.channelId}`);
              }
            }
          }
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
}
