/**
 * setup/doctor.ts — Workspace diagnostic engine.
 *
 * Validates workspace integrity: files, config, projects, prompts, labels.
 * Used by both `openclaw fabrica doctor` and `openclaw fabrica validate` CLI commands.
 *
 * doctor runs checks and optionally applies fixes.
 * validate is a dry-run (never fixes).
 */
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { DATA_DIR } from "./constants.js";
import { migrateWorkspaceLayout } from "./migrate-layout.js";
import { loadConfig } from "../config/index.js";
import { getAllRoleIds } from "../roles/index.js";
import type { ProjectsData } from "../projects/types.js";
import { resolveGitHubWebhookSecret } from "../github/config-credentials.js";
import { readFabricaTelegramConfig } from "../telegram/config.js";
// ensureDefaultFiles is imported lazily to avoid triggering template loading
// at import time (templates resolve paths relative to dist/, not lib/setup/).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckSeverity = "ok" | "warn" | "error";

export type CheckResult = {
  name: string;
  severity: CheckSeverity;
  message: string;
  fixed?: boolean;
};

export type DoctorOpts = {
  workspacePath: string;
  fix?: boolean;
  /**
   * Optional plugin config for additional checks (e.g. Telegram bootstrap config validation).
   * If provided, enables plugin-level checks that require runtime config.
   */
  pluginConfig?: Record<string, unknown>;
};

export type DoctorResult = {
  checks: CheckResult[];
  errors: number;
  warnings: number;
  fixed: number;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run all diagnostic checks on a workspace.
 */
export async function runDoctor(opts: DoctorOpts): Promise<DoctorResult> {
  const checks: CheckResult[] = [];
  const { workspacePath, fix = false } = opts;
  await migrateWorkspaceLayout(workspacePath);
  const dataDir = path.join(workspacePath, DATA_DIR);

  // 1. Data directory exists
  checks.push(await checkDirExists(dataDir, `Data directory (${DATA_DIR}/)`));

  // 2. Core files exist
  checks.push(await checkFileExists(path.join(dataDir, "projects.json"), "projects.json"));
  checks.push(await checkFileExists(path.join(dataDir, "workflow.yaml"), "workflow.yaml"));

  // 3. Subdirectories exist
  checks.push(await checkDirExists(path.join(dataDir, "prompts"), "prompts/"));
  checks.push(await checkDirExists(path.join(dataDir, "projects"), "projects/"));
  checks.push(await checkDirExists(path.join(dataDir, "log"), "log/"));

  // 4. Workspace markdown files
  for (const file of ["AGENTS.md", "HEARTBEAT.md", "TOOLS.md"]) {
    checks.push(await checkFileExists(path.join(workspacePath, file), file));
  }

  // 5. Prompt files for all roles
  for (const role of getAllRoleIds()) {
    checks.push(await checkFileExists(
      path.join(dataDir, "prompts", `${role}.md`),
      `prompts/${role}.md`,
    ));
  }

  // 6. workflow.yaml is valid YAML
  checks.push(await checkWorkflowYaml(dataDir));

  // 7. projects.json is valid JSON with correct structure
  checks.push(await checkProjectsJson(dataDir));

  // 8. Config loads without errors (3-layer merge)
  checks.push(await checkConfigLoads(workspacePath));

  // 9. Project-level checks
  const projectChecks = await checkProjects(dataDir);
  checks.push(...projectChecks);

  // 10. Plugin config checks (optional — only when pluginConfig is provided)
  if (opts.pluginConfig) {
    checks.push(checkTelegramBootstrapConfig(opts.pluginConfig));
    checks.push(checkGitHubWebhookMode(opts.pluginConfig));
  }

  // If fix requested, try to repair missing files by re-running ensureDefaultFiles
  let fixed = 0;
  if (fix) {
    const hasErrors = checks.some(c => c.severity === "error");
    if (hasErrors) {
      try {
        const { ensureDefaultFiles } = await import("./workspace.js");
        await ensureDefaultFiles(workspacePath);
        // Re-check all failed checks (files, dirs, and config)
        for (const check of checks) {
          if (check.severity !== "error") continue;
          let recheckOk = false;
          if (check.name.startsWith("file:")) {
            const recheckPath = check.name.replace("file:", "");
            try { await fs.access(recheckPath); recheckOk = true; } catch { /* still missing */ }
          } else if (check.name.startsWith("dir:")) {
            const recheckPath = check.name.replace("dir:", "");
            try {
              const stat = await fs.stat(recheckPath);
              recheckOk = stat.isDirectory();
            } catch { /* still missing */ }
          } else if (check.name === "yaml:workflow") {
            recheckOk = (await checkWorkflowYaml(dataDir)).severity === "ok";
          } else if (check.name === "json:projects") {
            recheckOk = (await checkProjectsJson(dataDir)).severity === "ok";
          }
          if (recheckOk) {
            check.fixed = true;
            check.severity = "ok";
            check.message += " (fixed)";
            fixed++;
          }
        }
      } catch { /* ensureDefaultFiles failed */ }
    }
  }

  return {
    checks,
    errors: checks.filter(c => c.severity === "error").length,
    warnings: checks.filter(c => c.severity === "warn").length,
    fixed,
  };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkDirExists(dirPath: string, label: string): Promise<CheckResult> {
  try {
    const stat = await fs.stat(dirPath);
    if (stat.isDirectory()) {
      return { name: `dir:${dirPath}`, severity: "ok", message: `${label} exists` };
    }
    return { name: `dir:${dirPath}`, severity: "error", message: `${label} is not a directory` };
  } catch {
    return { name: `dir:${dirPath}`, severity: "error", message: `${label} missing` };
  }
}

async function checkFileExists(filePath: string, label: string): Promise<CheckResult> {
  try {
    await fs.access(filePath);
    return { name: `file:${filePath}`, severity: "ok", message: `${label} exists` };
  } catch {
    return { name: `file:${filePath}`, severity: "error", message: `${label} missing` };
  }
}

async function checkWorkflowYaml(dataDir: string): Promise<CheckResult> {
  const filePath = path.join(dataDir, "workflow.yaml");
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = YAML.parse(content);
    if (!parsed || typeof parsed !== "object") {
      return { name: "yaml:workflow", severity: "error", message: "workflow.yaml is empty or not an object" };
    }
    if (!parsed.roles && !parsed.workflow) {
      return { name: "yaml:workflow", severity: "warn", message: "workflow.yaml has no roles section (built-in defaults will be used)" };
    }
    return { name: "yaml:workflow", severity: "ok", message: "workflow.yaml is valid" };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { name: "yaml:workflow", severity: "error", message: "workflow.yaml not found" };
    }
    return { name: "yaml:workflow", severity: "error", message: `workflow.yaml parse error: ${err.message}` };
  }
}

async function checkProjectsJson(dataDir: string): Promise<CheckResult> {
  const filePath = path.join(dataDir, "projects.json");
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") {
      return { name: "json:projects", severity: "error", message: "projects.json is not an object" };
    }
    if (!parsed.projects || typeof parsed.projects !== "object") {
      return { name: "json:projects", severity: "error", message: "projects.json missing 'projects' key" };
    }
    const count = Object.keys(parsed.projects).length;
    return { name: "json:projects", severity: "ok", message: `projects.json valid (${count} project${count !== 1 ? "s" : ""})` };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { name: "json:projects", severity: "error", message: "projects.json not found" };
    }
    return { name: "json:projects", severity: "error", message: `projects.json parse error: ${err.message}` };
  }
}

async function checkConfigLoads(workspacePath: string): Promise<CheckResult> {
  try {
    const config = await loadConfig(workspacePath);
    const roleCount = Object.keys(config.roles).length;
    const stateCount = Object.keys(config.workflow.states).length;
    return {
      name: "config:load",
      severity: "ok",
      message: `Config loaded: ${roleCount} roles, ${stateCount} states`,
    };
  } catch (err: any) {
    return {
      name: "config:load",
      severity: "error",
      message: `Config load failed: ${err.message}`,
    };
  }
}

function checkTelegramBootstrapConfig(pluginConfig: Record<string, unknown>): CheckResult {
  const rawTelegram = ((pluginConfig as any)?.telegram ?? {}) as Record<string, unknown>;
  const telegram = readFabricaTelegramConfig(pluginConfig);

  if (rawTelegram.bootstrapDmEnabled === false) {
    return {
      name: "config:telegram-bootstrap",
      severity: "ok",
      message: "Telegram DM bootstrap is disabled (bootstrapDmEnabled=false)",
    };
  }
  if (!telegram.projectsForumChatId) {
    return {
      name: "config:telegram-bootstrap",
      severity: "warn",
      message: "Telegram DM bootstrap is active by default but projectsForumChatId is not configured in plugins.entries.fabrica.config.telegram — the official DM → topic flow will fail at runtime",
    };
  }
  return {
    name: "config:telegram-bootstrap",
    severity: "ok",
    message: `Telegram DM bootstrap configured (projectsForumChatId: ${telegram.projectsForumChatId})`,
  };
}

export function checkGitHubWebhookMode(
  pluginConfig: Record<string, unknown> | undefined,
): CheckResult {
  const mode = (pluginConfig as any)?.providers?.github?.webhookMode ?? "optional";
  const hasSecret = Boolean(resolveGitHubWebhookSecret(pluginConfig));

  if (mode === "disabled") {
    return { name: "github-webhook", severity: "ok", message: "Webhook disabled — polling-only mode" };
  }
  if (mode === "required" && !hasSecret) {
    return { name: "github-webhook", severity: "error", message: "webhookMode is 'required' but no webhook secret is configured" };
  }
  if (mode === "optional" && !hasSecret) {
    return { name: "github-webhook", severity: "ok", message: "Webhook not configured — running in polling-only mode (FabricaRun creation via heartbeat polling)" };
  }
  return { name: "github-webhook", severity: "ok", message: "Webhook configured" };
}

async function checkProjects(dataDir: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const filePath = path.join(dataDir, "projects.json");

  let data: ProjectsData;
  try {
    const content = await fs.readFile(filePath, "utf-8");
    data = JSON.parse(content) as ProjectsData;
  } catch {
    return results; // Already reported by checkProjectsJson
  }

  for (const [slug, project] of Object.entries(data.projects)) {
    // Check slug field
    if (!project.slug) {
      results.push({
        name: `project:${slug}:slug`,
        severity: "error",
        message: `Project "${slug}" missing slug field`,
      });
    }

    // Check channels
    if (!project.channels || project.channels.length === 0) {
      results.push({
        name: `project:${slug}:channels`,
        severity: "warn",
        message: `Project "${slug}" has no channels`,
      });
    } else {
      for (const ch of project.channels) {
        if (!ch.channelId) {
          results.push({
            name: `project:${slug}:channel:id`,
            severity: "error",
            message: `Project "${slug}" has a channel without channelId`,
          });
        }
      }
    }

    // Check repo
    if (!project.repo) {
      results.push({
        name: `project:${slug}:repo`,
        severity: "error",
        message: `Project "${slug}" missing repo field`,
      });
    }

    // Check qa.sh in the actual project repository.
    if (project.repo && path.isAbsolute(project.repo)) {
      const qaPath = path.join(project.repo, "scripts", "qa.sh");
      try {
        await fs.access(qaPath);
      } catch {
        results.push({
          name: `project:${slug}:qa`,
          severity: "warn",
          message: `Project "${slug}" has no scripts/qa.sh in repo path ${project.repo}`,
        });
      }
    }
  }

  return results;
}
