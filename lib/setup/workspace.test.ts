/**
 * workspace.test.ts — Tests for write-once default file behavior.
 *
 * Verifies that ensureDefaultFiles() creates missing files but never
 * overwrites user-owned config (workflow.yaml, prompts, IDENTITY.md).
 *
 * Run: npx tsx --test lib/setup/workspace.test.ts
 */
import { describe, it, afterEach } from "vitest";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ensureDefaultFiles, fileExists } from "./workspace.js";
import { DATA_DIR } from "./constants.js";

let tmpDir: string;

async function makeTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-ws-test-"));
  // Create the log dir so audit logging doesn't fail
  await fs.mkdir(path.join(tmpDir, DATA_DIR, "log"), { recursive: true });
  return tmpDir;
}

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("ensureDefaultFiles — write-once behavior", () => {
  it("should create workflow.yaml when missing", async () => {
    const ws = await makeTmpDir();
    await ensureDefaultFiles(ws);
    const workflowPath = path.join(ws, DATA_DIR, "workflow.yaml");
    assert.ok(await fileExists(workflowPath), "workflow.yaml should be created");
  });

  it("should NOT overwrite existing workflow.yaml", async () => {
    const ws = await makeTmpDir();
    const workflowPath = path.join(ws, DATA_DIR, "workflow.yaml");
    await fs.mkdir(path.dirname(workflowPath), { recursive: true });
    const customContent = "# My custom workflow\nroles:\n  developer:\n    models:\n      junior: openai/gpt-4\n";
    await fs.writeFile(workflowPath, customContent, "utf-8");

    await ensureDefaultFiles(ws);

    const afterContent = await fs.readFile(workflowPath, "utf-8");
    assert.strictEqual(afterContent, customContent, "workflow.yaml should not be overwritten");
  });

  it("should migrate unsafe reviewer merge actions in existing workflow.yaml", async () => {
    const ws = await makeTmpDir();
    const workflowPath = path.join(ws, DATA_DIR, "workflow.yaml");
    await fs.mkdir(path.dirname(workflowPath), { recursive: true });
    await fs.writeFile(workflowPath, [
      "workflow:",
      "  states:",
      "    toReview:",
      "      type: queue",
      "      role: reviewer",
      "      label: To Review",
      "      color: \"#7057ff\"",
      "      on:",
      "        APPROVED:",
      "          target: toTest",
      "          actions:",
      "            - mergePr",
      "            - gitPull",
      "    toTest:",
      "      type: queue",
      "      role: tester",
      "      label: To Test",
      "      color: \"#5bc0de\"",
    ].join("\n"), "utf-8");

    await ensureDefaultFiles(ws);

    const afterContent = await fs.readFile(workflowPath, "utf-8");
    assert.ok(!afterContent.includes("mergePr"), "unsafe reviewer merge should be removed");
    assert.ok(await fileExists(`${workflowPath}.bak`), "migration should create a backup");
  });

  it("should create prompt files when missing", async () => {
    const ws = await makeTmpDir();
    await ensureDefaultFiles(ws);
    const devPrompt = path.join(ws, DATA_DIR, "prompts", "developer.md");
    assert.ok(await fileExists(devPrompt), "developer.md prompt should be created");
  });

  it("should create security-checklist.md when missing", async () => {
    const ws = await makeTmpDir();
    await ensureDefaultFiles(ws);
    const checklistPath = path.join(ws, DATA_DIR, "prompts", "security-checklist.md");
    const legacyChecklistPath = path.join(ws, "prompts", "security-checklist.md");
    assert.ok(await fileExists(checklistPath), "security-checklist.md should be created");
    assert.ok(
      !(await fileExists(legacyChecklistPath)),
      "legacy workspace-root security-checklist.md should not be created anymore",
    );
    const content = await fs.readFile(checklistPath, "utf-8");
    assert.ok(content.trim().length > 0, "security-checklist.md should not be empty");
  });

  it("should NOT overwrite existing prompt files", async () => {
    const ws = await makeTmpDir();
    const devPrompt = path.join(ws, DATA_DIR, "prompts", "developer.md");
    await fs.mkdir(path.dirname(devPrompt), { recursive: true });
    const customPrompt = "# My custom developer instructions\nAlways use TypeScript.";
    await fs.writeFile(devPrompt, customPrompt, "utf-8");

    await ensureDefaultFiles(ws);

    const afterContent = await fs.readFile(devPrompt, "utf-8");
    assert.strictEqual(afterContent, customPrompt, "developer.md should not be overwritten");
  });

  it("should NOT overwrite an existing security checklist", async () => {
    const ws = await makeTmpDir();
    const checklistPath = path.join(ws, DATA_DIR, "prompts", "security-checklist.md");
    await fs.mkdir(path.dirname(checklistPath), { recursive: true });
    const customChecklist = "# Custom checklist\n- Verify org-specific controls";
    await fs.writeFile(checklistPath, customChecklist, "utf-8");

    await ensureDefaultFiles(ws);

    const afterContent = await fs.readFile(checklistPath, "utf-8");
    assert.strictEqual(afterContent, customChecklist, "security-checklist.md should not be overwritten");
  });

  it("should NOT delete project-specific prompts", async () => {
    const ws = await makeTmpDir();
    const projectPrompt = path.join(ws, DATA_DIR, "projects", "my-app", "prompts", "developer.md");
    await fs.mkdir(path.dirname(projectPrompt), { recursive: true });
    const customPrompt = "# My App Developer\nUse React.";
    await fs.writeFile(projectPrompt, customPrompt, "utf-8");

    await ensureDefaultFiles(ws);

    assert.ok(await fileExists(projectPrompt), "project-specific prompt should still exist");
    const afterContent = await fs.readFile(projectPrompt, "utf-8");
    assert.strictEqual(afterContent, customPrompt, "project-specific prompt should be untouched");
  });

  it("should create IDENTITY.md when missing but not overwrite", async () => {
    const ws = await makeTmpDir();

    // First run: creates it
    await ensureDefaultFiles(ws);
    const identityPath = path.join(ws, "IDENTITY.md");
    assert.ok(await fileExists(identityPath), "IDENTITY.md should be created");

    // Customize it
    const customIdentity = "# My Identity\nI am a lobster.";
    await fs.writeFile(identityPath, customIdentity, "utf-8");

    // Second run: should NOT overwrite
    await ensureDefaultFiles(ws);
    const afterContent = await fs.readFile(identityPath, "utf-8");
    assert.strictEqual(afterContent, customIdentity, "IDENTITY.md should not be overwritten");
  });

  it("should always overwrite AGENTS.md (system instructions)", async () => {
    const ws = await makeTmpDir();
    const agentsPath = path.join(ws, "AGENTS.md");
    await fs.writeFile(agentsPath, "# Old agents content", "utf-8");

    await ensureDefaultFiles(ws);

    const afterContent = await fs.readFile(agentsPath, "utf-8");
    assert.notStrictEqual(afterContent, "# Old agents content", "AGENTS.md should be overwritten");
  });

  it("should write .version file", async () => {
    const ws = await makeTmpDir();
    await ensureDefaultFiles(ws);
    const versionPath = path.join(ws, DATA_DIR, ".version");
    assert.ok(await fileExists(versionPath), ".version file should be created");
    const content = await fs.readFile(versionPath, "utf-8");
    assert.ok(content.trim().length > 0, ".version should contain a version string");
  });

  it("should write the workspace layout version marker inside fabrica/", async () => {
    const ws = await makeTmpDir();
    await ensureDefaultFiles(ws);
    const layoutVersionPath = path.join(ws, DATA_DIR, ".layout-version");
    assert.ok(await fileExists(layoutVersionPath), ".layout-version should be created in fabrica/");
    const content = await fs.readFile(layoutVersionPath, "utf-8");
    assert.strictEqual(content.trim(), "fabrica-v1", ".layout-version should record the canonical layout");
  });
});
