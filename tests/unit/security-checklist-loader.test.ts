import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSecurityChecklist } from "../../lib/dispatch/security-checklist.js";
import { DATA_DIR } from "../../lib/setup/constants.js";

describe("loadSecurityChecklist", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-security-checklist-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("prefers the project-specific checklist when present", async () => {
    const projectPath = path.join(workspaceDir, DATA_DIR, "projects", "demo", "prompts");
    const workspacePath = path.join(workspaceDir, DATA_DIR, "prompts");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, "security-checklist.md"), "workspace checklist\n", "utf-8");
    await fs.writeFile(path.join(projectPath, "security-checklist.md"), "project checklist\n", "utf-8");

    const checklist = await loadSecurityChecklist(workspaceDir, "demo");

    expect(checklist).toBe("project checklist\n");
  });

  it("falls back to the workspace checklist when there is no project override", async () => {
    const workspacePath = path.join(workspaceDir, DATA_DIR, "prompts");
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, "security-checklist.md"), "workspace checklist\n", "utf-8");

    const checklist = await loadSecurityChecklist(workspaceDir, "demo");

    expect(checklist).toBe("workspace checklist\n");
  });

  it("falls back to the built-in default when no workspace files exist", async () => {
    const checklist = await loadSecurityChecklist(workspaceDir, "demo");

    expect(checklist.trim().length).toBeGreaterThan(0);
    expect(checklist.toLowerCase()).toContain("security");
  });
});
