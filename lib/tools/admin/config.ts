/**
 * config — Config management tool for Fabrica workspaces.
 *
 * Subcommands:
 * - reset: Reset config files to package defaults (with .bak backups)
 * - diff: Show differences between current workflow.yaml and package default
 * - version: Show current and workspace Fabrica versions
 */
import fs from "node:fs/promises";
import path from "node:path";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../../types.js";
import type { PluginContext } from "../../context.js";
import { writeAllDefaults, backupAndWrite, fileExists } from "../../setup/workspace.js";
import { WORKFLOW_YAML_TEMPLATE, DEFAULT_ROLE_INSTRUCTIONS } from "../../setup/templates.js";
import { DATA_DIR } from "../../setup/migrate-layout.js";
import { getCurrentVersion, readVersionFile } from "../../setup/version.js";
import { loadConfig } from "../../config/loader.js";

export function createConfigTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "config",
    label: "Config",
    description: `Manage Fabrica workspace configuration.

Actions:
- **reset**: Reset config files to package defaults. Creates .bak backups of existing files.
  Scope: --prompts (prompts only), --workflow (workflow.yaml only), --all (everything).
- **diff**: Show differences between current workflow.yaml and the package default template.
- **trace**: Show the config merge trace — which layer (built-in/workspace/project) contributed each config value.
- **version**: Show Fabrica package version and workspace tracked version.

Examples:
  config({ action: "reset", scope: "workflow" })
  config({ action: "reset", scope: "all" })
  config({ action: "diff" })
  config({ action: "trace" })
  config({ action: "trace", project: "my-project" })
  config({ action: "version" })`,
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["reset", "diff", "trace", "version"],
          description: "Config action to perform.",
        },
        scope: {
          type: "string",
          enum: ["prompts", "workflow", "all"],
          description: "Scope for reset action. Default: all.",
        },
        project: {
          type: "string",
          description: "Project name for trace action. Optional — omit for workspace-level trace.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const action = params.action as string;
      const workspacePath = toolCtx.workspaceDir;
      if (!workspacePath) throw new Error("No workspace directory available");

      switch (action) {
        case "reset":
          return await handleReset(workspacePath, (params.scope as string) ?? "all");
        case "diff":
          return await handleDiff(workspacePath);
        case "trace":
          return await handleTrace(workspacePath, params.project as string | undefined);
        case "version":
          return await handleVersion(workspacePath);
        default:
          throw new Error(`Unknown config action: ${action}`);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleReset(workspacePath: string, scope: string) {
  const dataDir = path.join(workspacePath, DATA_DIR);
  const written: string[] = [];

  if (scope === "all") {
    const files = await writeAllDefaults(workspacePath, true);
    written.push(...files);
  } else if (scope === "workflow") {
    const workflowPath = path.join(dataDir, "workflow.yaml");
    await backupAndWrite(workflowPath, WORKFLOW_YAML_TEMPLATE);
    written.push("fabrica/workflow.yaml");
  } else if (scope === "prompts") {
    const promptsDir = path.join(dataDir, "prompts");
    for (const [role, content] of Object.entries(DEFAULT_ROLE_INSTRUCTIONS)) {
      if (!content) continue;
      const rolePath = path.join(promptsDir, `${role}.md`);
      await backupAndWrite(rolePath, content);
      written.push(`fabrica/prompts/${role}.md`);
    }
  } else {
    throw new Error(`Unknown scope: ${scope}. Use: prompts, workflow, or all.`);
  }

  return jsonResult({
    success: true,
    action: "reset",
    scope,
    filesWritten: written,
    summary: written.length > 0
      ? `Reset ${written.length} file(s) to package defaults (.bak backups created):\n${written.map(f => `  ${f}`).join("\n")}`
      : "No files to reset.",
  });
}

async function handleDiff(workspacePath: string) {
  const workflowPath = path.join(workspacePath, DATA_DIR, "workflow.yaml");

  if (!await fileExists(workflowPath)) {
    return jsonResult({
      success: true,
      action: "diff",
      summary: "No workflow.yaml found in workspace — using package defaults.",
    });
  }

  const current = await fs.readFile(workflowPath, "utf-8");
  const template = WORKFLOW_YAML_TEMPLATE;

  if (current.trim() === template.trim()) {
    return jsonResult({
      success: true,
      action: "diff",
      summary: "workflow.yaml matches the package default — no differences.",
    });
  }

  // Simple line-by-line diff
  const currentLines = current.split("\n");
  const templateLines = template.split("\n");
  const diffs: string[] = [];

  const maxLen = Math.max(currentLines.length, templateLines.length);
  for (let i = 0; i < maxLen; i++) {
    const cl = currentLines[i] ?? "";
    const tl = templateLines[i] ?? "";
    if (cl !== tl) {
      if (tl && !cl) diffs.push(`+${i + 1}: ${tl}`);
      else if (cl && !tl) diffs.push(`-${i + 1}: ${cl}`);
      else {
        diffs.push(`-${i + 1}: ${cl}`);
        diffs.push(`+${i + 1}: ${tl}`);
      }
    }
  }

  return jsonResult({
    success: true,
    action: "diff",
    differences: diffs.length,
    summary: `workflow.yaml differs from package default (${diffs.length} line(s)):\n\`\`\`diff\n${diffs.join("\n")}\n\`\`\`\n\nUse \`config({ action: "reset", scope: "workflow" })\` to reset to defaults.`,
  });
}

async function handleTrace(workspacePath: string, project?: string) {
  const resolved = await loadConfig(workspacePath, project);
  const trace = (resolved as any)._trace ?? {};
  const entries = Object.entries(trace).sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    return jsonResult({
      success: true,
      action: "trace",
      project: project ?? null,
      summary: "No merge trace available — config is using built-in defaults only.",
      trace: {},
    });
  }

  const lines = entries.map(([p, layer]) => `  ${p.padEnd(50)} ← ${layer}`);
  const header = project
    ? `Config merge trace for project: ${project}`
    : "Config merge trace (workspace level)";

  return jsonResult({
    success: true,
    action: "trace",
    project: project ?? null,
    entryCount: entries.length,
    summary: [header, ...lines].join("\n"),
    trace,
  });
}

async function handleVersion(workspacePath: string) {
  const packageVersion = getCurrentVersion();
  const dataDir = path.join(workspacePath, DATA_DIR);
  const workspaceVersion = await readVersionFile(dataDir);

  const match = workspaceVersion === packageVersion;

  return jsonResult({
    success: true,
    action: "version",
    packageVersion,
    workspaceVersion: workspaceVersion ?? "(not tracked)",
    match,
    summary: match
      ? `Fabrica v${packageVersion} — workspace up to date.`
      : workspaceVersion
        ? `Fabrica v${packageVersion} (workspace tracked: v${workspaceVersion}) — version mismatch.`
        : `Fabrica v${packageVersion} — workspace version not yet tracked.`,
  });
}
