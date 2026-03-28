import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SECURITY_CHECKLIST } from "../setup/templates.js";
import { DATA_DIR } from "../setup/constants.js";

export async function loadSecurityChecklist(
  workspaceDir: string,
  projectName: string,
): Promise<string> {
  const dataDir = path.join(workspaceDir, DATA_DIR);
  const candidates = [
    path.join(dataDir, "projects", projectName, "prompts", "security-checklist.md"),
    path.join(dataDir, "prompts", "security-checklist.md"),
  ];

  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate, "utf-8");
      if (content.trim()) return content;
    } catch {
      /* try next */
    }
  }

  return DEFAULT_SECURITY_CHECKLIST;
}
