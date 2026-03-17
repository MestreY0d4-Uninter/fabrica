/**
 * Shared templates for workspace files.
 * Used by setup and project_register.
 *
 * All templates are loaded from defaults/ at the repo root.
 * These files serve as both documentation and the runtime source of truth.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadFabricaManifest, resolvePackagedAssetPath } from "./manifest.js";
// ---------------------------------------------------------------------------
// File loader — reads from defaults/ (single source of truth)
// ---------------------------------------------------------------------------

function resolveDefaultsDir(): string {
  const manifest = loadFabricaManifest();
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolvePackagedAssetPath(manifest.assets.defaultsDir),
    // Source tree: lib/setup/templates.ts -> ../../defaults
    path.join(baseDir, "..", "..", "defaults"),
    // Bundled tree: dist/index.js or dist/setup/templates.js -> ../defaults
    path.join(baseDir, "..", "defaults"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return candidates[0]!;
}

const DEFAULTS_DIR = resolveDefaultsDir();

function loadDefault(filename: string): string {
  const filePath = path.join(DEFAULTS_DIR, filename);
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to load default file: ${filePath} (${(err as Error).message})`);
  }
}

// ---------------------------------------------------------------------------
// Role prompts — defaults/developer.md, defaults/tester.md, etc.
// ---------------------------------------------------------------------------

function loadPromptDefault(filename: string): string {
  const candidates = [
    path.join("fabrica", "prompts", filename),
    // Legacy packaged defaults kept as a compatibility fallback while old
    // installations are migrated. New assets must live under fabrica/.
    path.join("devclaw", "prompts", filename),
  ];

  for (const candidate of candidates) {
    try {
      return loadDefault(candidate);
    } catch {
      /* try next */
    }
  }

  throw new Error(`Failed to load default prompt: ${filename}`);
}

function loadWorkflowDefault(): string {
  const candidates = [
    path.join("fabrica", "workflow.yaml"),
    // Legacy packaged defaults kept as a compatibility fallback while old
    // installations are migrated. New assets must live under fabrica/.
    path.join("devclaw", "workflow.yaml"),
  ];

  for (const candidate of candidates) {
    try {
      return loadDefault(candidate);
    } catch {
      /* try next */
    }
  }

  throw new Error("Failed to load default workflow.yaml");
}

const DEFAULT_DEV_INSTRUCTIONS = loadPromptDefault("developer.md");
const DEFAULT_QA_INSTRUCTIONS = loadPromptDefault("tester.md");
const DEFAULT_ARCHITECT_INSTRUCTIONS = loadPromptDefault("architect.md");
const DEFAULT_REVIEWER_INSTRUCTIONS = loadPromptDefault("reviewer.md");
export const DEFAULT_SECURITY_CHECKLIST = loadPromptDefault("security-checklist.md");

/** Default role instructions indexed by role ID. Used by project scaffolding. */
export const DEFAULT_ROLE_INSTRUCTIONS: Record<string, string> = {
  developer: DEFAULT_DEV_INSTRUCTIONS,
  tester: DEFAULT_QA_INSTRUCTIONS,
  architect: DEFAULT_ARCHITECT_INSTRUCTIONS,
  reviewer: DEFAULT_REVIEWER_INSTRUCTIONS,
};

// ---------------------------------------------------------------------------
// Workspace templates — defaults/AGENTS.md, defaults/SOUL.md, etc.
// ---------------------------------------------------------------------------

export const AGENTS_MD_TEMPLATE = loadDefault("AGENTS.md");
export const HEARTBEAT_MD_TEMPLATE = loadDefault("HEARTBEAT.md");
export const IDENTITY_MD_TEMPLATE = loadDefault("IDENTITY.md");
export const SOUL_MD_TEMPLATE = loadDefault("SOUL.md");
export const TOOLS_MD_TEMPLATE = loadDefault("TOOLS.md");

// ---------------------------------------------------------------------------
// Workflow YAML — roles generated from registry + workflow section from file
// ---------------------------------------------------------------------------

export const WORKFLOW_YAML_TEMPLATE = loadWorkflowDefault();
