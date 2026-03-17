/**
 * setup/workspace.ts — Workspace file scaffolding.
 *
 * On startup, ensureDefaultFiles() creates missing workspace files with curated
 * defaults. User-owned config files (workflow.yaml, prompts, IDENTITY.md) are
 * write-once: created if missing, never overwritten. System instruction files
 * (AGENTS.md, HEARTBEAT.md, TOOLS.md) are always refreshed.
 *
 * The runtime config loader (lib/config/loader.ts) uses a three-layer merge with
 * built-in fallbacks, so missing keys in workflow.yaml are handled automatically.
 *
 * To explicitly write/reset defaults, use setup --eject-defaults or --reset-defaults.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  AGENTS_MD_TEMPLATE,
  HEARTBEAT_MD_TEMPLATE,
  IDENTITY_MD_TEMPLATE,
  SOUL_MD_TEMPLATE,
  TOOLS_MD_TEMPLATE,
  WORKFLOW_YAML_TEMPLATE,
  DEFAULT_ROLE_INSTRUCTIONS,
  DEFAULT_SECURITY_CHECKLIST,
} from "./templates.js";
import { getAllRoleIds } from "../roles/index.js";
import { migrateWorkspaceLayout, DATA_DIR } from "./migrate-layout.js";
import { writeWorkspaceLayoutVersion } from "./workspace-layout.js";
import { writeVersionFile, detectUpgrade } from "./version.js";
import { log as auditLog } from "../audit.js";
import { migrateWorkspaceWorkflowFiles } from "./workflow-migration.js";

/** Sentinel file indicating the workspace has been initialized. */
const INITIALIZED_SENTINEL = ".initialized";

/**
 * Ensure all workspace data files are up to date.
 *
 * Called on every heartbeat startup.
 *
 * File categories:
 *   - System instructions (AGENTS.md, HEARTBEAT.md, TOOLS.md): always overwrite
 *   - User-owned config (workflow.yaml, prompts, IDENTITY.md): create-only
 *   - Runtime state (projects.json): create-only
 */
export async function ensureDefaultFiles(workspacePath: string): Promise<void> {
  await migrateWorkspaceLayout(workspacePath);
  const dataDir = path.join(workspacePath, DATA_DIR);
  await fs.mkdir(dataDir, { recursive: true });

  // Ensure directories exist
  await fs.mkdir(path.join(dataDir, "projects"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "prompts"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "log"), { recursive: true });

  // --- System instruction files — always overwrite with latest ---
  await backupAndWrite(path.join(workspacePath, "AGENTS.md"), AGENTS_MD_TEMPLATE);
  await backupAndWrite(path.join(workspacePath, "HEARTBEAT.md"), HEARTBEAT_MD_TEMPLATE);
  await backupAndWrite(path.join(workspacePath, "TOOLS.md"), TOOLS_MD_TEMPLATE);

  // --- User-owned files — create-only, never overwrite ---

  // IDENTITY.md
  const identityPath = path.join(workspacePath, "IDENTITY.md");
  if (!await fileExists(identityPath)) {
    await fs.writeFile(identityPath, IDENTITY_MD_TEMPLATE, "utf-8");
  }

  // Remove BOOTSTRAP.md — one-time onboarding file, not needed after setup
  try { await fs.unlink(path.join(workspacePath, "BOOTSTRAP.md")); } catch { /* already gone */ }

  // fabrica/workflow.yaml — create-only (three-layer merge handles defaults for missing keys)
  const workflowPath = path.join(dataDir, "workflow.yaml");
  await writeIfMissing(workflowPath, WORKFLOW_YAML_TEMPLATE);

  // fabrica/projects.json — create-only
  const projectsJsonPath = path.join(dataDir, "projects.json");
  await writeIfMissing(projectsJsonPath, JSON.stringify({ projects: {} }, null, 2) + "\n");

  // fabrica/prompts/ — create-only per role (user customizations are preserved)
  for (const role of getAllRoleIds()) {
    const rolePath = path.join(dataDir, "prompts", `${role}.md`);
    const content = DEFAULT_ROLE_INSTRUCTIONS[role];
    if (content) await writeIfMissing(rolePath, content);
  }
  await writeIfMissing(path.join(dataDir, "prompts", "security-checklist.md"), DEFAULT_SECURITY_CHECKLIST);

  const workflowMigrations = await migrateWorkspaceWorkflowFiles(workspacePath).catch(() => []);
  for (const migration of workflowMigrations) {
    await auditLog(workspacePath, "workflow_migrated", {
      file: path.relative(workspacePath, migration.file),
      fixes: migration.fixes.map((fix) => ({
        stateKey: fix.stateKey,
        event: fix.event,
        removedActions: fix.removedActions,
        addedActions: fix.addedActions ?? [],
        reason: fix.reason,
      })),
    });
  }

  // Version tracking
  const upgrade = await detectUpgrade(dataDir);
  await writeVersionFile(dataDir);
  await writeWorkspaceLayoutVersion(workspacePath);
  if (upgrade) {
    await auditLog(workspacePath, "version_upgrade", {
      from: upgrade.from,
      to: upgrade.to,
    });
  }

  // Mark workspace as initialized
  const sentinelPath = path.join(dataDir, INITIALIZED_SENTINEL);
  await writeIfMissing(sentinelPath, new Date().toISOString() + "\n");
}

/**
 * Write all package defaults to workspace.
 * Used by setup --eject-defaults and --reset-defaults.
 *
 * @param force — If true, overwrite existing files (reset-defaults). If false, skip existing (eject-defaults).
 * @returns List of files written.
 */
export async function writeAllDefaults(workspacePath: string, force = false): Promise<string[]> {
  await migrateWorkspaceLayout(workspacePath);
  const dataDir = path.join(workspacePath, DATA_DIR);
  const written: string[] = [];

  // Ensure directories
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.join(dataDir, "projects"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "prompts"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "log"), { recursive: true });

  const files: Array<[string, string]> = [
    [path.join(workspacePath, "AGENTS.md"), AGENTS_MD_TEMPLATE],
    [path.join(workspacePath, "HEARTBEAT.md"), HEARTBEAT_MD_TEMPLATE],
    [path.join(workspacePath, "IDENTITY.md"), IDENTITY_MD_TEMPLATE],
    [path.join(workspacePath, "TOOLS.md"), TOOLS_MD_TEMPLATE],
    [path.join(dataDir, "workflow.yaml"), WORKFLOW_YAML_TEMPLATE],
  ];

  for (const role of getAllRoleIds()) {
    const content = DEFAULT_ROLE_INSTRUCTIONS[role];
    if (content) files.push([path.join(dataDir, "prompts", `${role}.md`), content]);
  }
  files.push([path.join(dataDir, "prompts", "security-checklist.md"), DEFAULT_SECURITY_CHECKLIST]);

  for (const [filePath, content] of files) {
    if (force) {
      await backupAndWrite(filePath, content);
      written.push(path.relative(workspacePath, filePath));
    } else {
      if (await writeIfMissing(filePath, content)) {
        written.push(path.relative(workspacePath, filePath));
      }
    }
  }

  // Version tracking
  const upgrade = await detectUpgrade(dataDir);
  await writeVersionFile(dataDir);
  await writeWorkspaceLayoutVersion(workspacePath);
  if (upgrade) {
    await auditLog(workspacePath, "version_upgrade", {
      from: upgrade.from,
      to: upgrade.to,
    });
  }

  return written;
}

/**
 * Write all workspace files for a Fabrica agent.
 * Returns the list of files that were written (skips files that already exist).
 *
 * @param defaultWorkspacePath — If provided, USER.md is copied from here (only if not already present).
 */
export async function scaffoldWorkspace(workspacePath: string, defaultWorkspacePath?: string): Promise<string[]> {
  // Migrate old layout if detected
  await migrateWorkspaceLayout(workspacePath);

  // SOUL.md (create-only — never overwrite user customizations)
  const soulPath = path.join(workspacePath, "SOUL.md");
  if (!await fileExists(soulPath)) {
    await fs.writeFile(soulPath, SOUL_MD_TEMPLATE, "utf-8");
  }

  // USER.md — copy from default workspace if available (create-only)
  const userPath = path.join(workspacePath, "USER.md");
  if (!await fileExists(userPath) && defaultWorkspacePath) {
    const sourceUser = path.join(defaultWorkspacePath, "USER.md");
    if (await fileExists(sourceUser)) {
      await fs.copyFile(sourceUser, userPath);
    }
  }

  // Ensure directories and missing structural files
  await ensureDefaultFiles(workspacePath);

  return ["AGENTS.md", "HEARTBEAT.md", "TOOLS.md"];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function backupAndWrite(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath);
    await fs.copyFile(filePath, filePath + ".bak");
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }
  await fs.writeFile(filePath, content, "utf-8");
}

/**
 * Write a file only if it doesn't exist. Returns true if file was written.
 */
async function writeIfMissing(filePath: string, content: string): Promise<boolean> {
  if (await fileExists(filePath)) return false;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  return true;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
