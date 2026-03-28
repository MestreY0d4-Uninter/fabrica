import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { FabricaConfig } from "../config/types.js";
import { validateConfig } from "../config/schema.js";
import { normalizeWorkflowDocument, type WorkflowNormalizationFix } from "../config/workflow-policy.js";
import { DATA_DIR } from "./constants.js";

export type WorkflowMigrationResult = {
  file: string;
  fixes: WorkflowNormalizationFix[];
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function backupAndWrite(filePath: string, content: string): Promise<void> {
  await fs.copyFile(filePath, `${filePath}.bak`);
  await fs.writeFile(filePath, content, "utf-8");
}

async function migrateFile(filePath: string): Promise<WorkflowMigrationResult | null> {
  const content = await fs.readFile(filePath, "utf-8");
  const parsed = YAML.parse(content) as FabricaConfig | null;
  if (!parsed || typeof parsed !== "object") return null;
  validateConfig(parsed);
  const { config, fixes } = normalizeWorkflowDocument(parsed);
  if (fixes.length === 0) return null;
  await backupAndWrite(filePath, YAML.stringify(config));
  return { file: filePath, fixes };
}

export async function migrateWorkspaceWorkflowFiles(workspacePath: string): Promise<WorkflowMigrationResult[]> {
  const results: WorkflowMigrationResult[] = [];
  const dataDir = path.join(workspacePath, DATA_DIR);
  const targets: string[] = [];

  const workspaceWorkflow = path.join(dataDir, "workflow.yaml");
  if (await fileExists(workspaceWorkflow)) targets.push(workspaceWorkflow);

  const projectsDir = path.join(dataDir, "projects");
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(projectsDir, entry.name, "workflow.yaml");
      if (await fileExists(filePath)) targets.push(filePath);
    }
  } catch {
    // no project overrides yet
  }

  for (const target of targets) {
    const migrated = await migrateFile(target);
    if (migrated) results.push(migrated);
  }

  return results;
}
