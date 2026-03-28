/**
 * Unit tests for admin tools — config and validateConfig (M3 + C3).
 *
 * Covers:
 * - config reset: creates .bak and writes defaults
 * - config diff: detects differences from package default
 * - config version: reports package vs workspace versions
 * - validateConfig: Zod schema rejects invalid timeout field values (C3)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "../../lib/setup/constants.js";
import { validateConfig } from "../../lib/config/schema.js";
import { createConfigTool } from "../../lib/tools/admin/config.js";
import { WORKFLOW_YAML_TEMPLATE } from "../../lib/setup/templates.js";

// ---------------------------------------------------------------------------
// Tests for validateConfig — Zod schema (C3)
// ---------------------------------------------------------------------------

describe("validateConfig — timeout field Zod validation (C3)", () => {
  it("accepts valid timeout configuration", () => {
    expect(() =>
      validateConfig({
        timeouts: {
          gitPullMs: 30000,
          auditLogMaxLines: 500,
          auditLogMaxBackups: 3,
          lockStaleMs: 30000,
          sessionConfirmAttempts: 5,
          sessionConfirmDelayMs: 250,
          sessionLabelMaxLength: 64,
          stallTimeoutMinutes: 15,
        },
      }),
    ).not.toThrow();
  });

  it("rejects auditLogMaxLines below minimum (100)", () => {
    expect(() =>
      validateConfig({ timeouts: { auditLogMaxLines: -5 } }),
    ).toThrow();
  });

  it("rejects auditLogMaxLines above maximum (10000)", () => {
    expect(() =>
      validateConfig({ timeouts: { auditLogMaxLines: 99999 } }),
    ).toThrow();
  });

  it("rejects lockStaleMs below minimum (5000)", () => {
    expect(() =>
      validateConfig({ timeouts: { lockStaleMs: 100 } }),
    ).toThrow();
  });

  it("rejects sessionConfirmAttempts above maximum (20)", () => {
    expect(() =>
      validateConfig({ timeouts: { sessionConfirmAttempts: 99 } }),
    ).toThrow();
  });

  it("rejects sessionConfirmDelayMs below minimum (50)", () => {
    expect(() =>
      validateConfig({ timeouts: { sessionConfirmDelayMs: 10 } }),
    ).toThrow();
  });

  it("rejects auditLogMaxBackups above maximum (10)", () => {
    expect(() =>
      validateConfig({ timeouts: { auditLogMaxBackups: 50 } }),
    ).toThrow();
  });

  it("rejects stallTimeoutMinutes below minimum (1)", () => {
    expect(() =>
      validateConfig({ timeouts: { stallTimeoutMinutes: 0 } }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests for config tool — reset, diff, schema
// ---------------------------------------------------------------------------

describe("config tool — structure and actions", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-admin-config-test-"));
    await fs.mkdir(path.join(workspaceDir, DATA_DIR), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  function makeTool(dir: string) {
    const mockPluginCtx = {
      workspaceDir: dir,
      runCommand: vi.fn(),
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;
    return createConfigTool(mockPluginCtx)({ workspaceDir: dir } as any);
  }

  it("returns a tool with the correct name and action enum", () => {
    const tool = makeTool(workspaceDir);
    expect(tool.name).toBe("config");
    expect(tool.parameters.properties.action.enum).toContain("reset");
    expect(tool.parameters.properties.action.enum).toContain("diff");
    expect(tool.parameters.properties.action.enum).toContain("version");
  });

  it("throws on unknown action", async () => {
    const tool = makeTool(workspaceDir);
    await expect(
      tool.execute("test-id", { action: "invalid" }),
    ).rejects.toThrow(/unknown config action/i);
  });

  it("throws on unknown reset scope", async () => {
    const tool = makeTool(workspaceDir);
    await expect(
      tool.execute("test-id", { action: "reset", scope: "not-a-scope" }),
    ).rejects.toThrow(/unknown scope/i);
  });

  it("reset with scope=workflow writes workflow.yaml and creates .bak", async () => {
    const tool = makeTool(workspaceDir);
    const workflowPath = path.join(workspaceDir, DATA_DIR, "workflow.yaml");
    await fs.writeFile(workflowPath, "initial: todo\n", "utf-8");

    const result = await tool.execute("test-id", { action: "reset", scope: "workflow" }) as any;
    const r = result?.details ?? result;

    expect(r.success).toBe(true);
    expect(r.filesWritten).toEqual(expect.arrayContaining(["fabrica/workflow.yaml"]));

    const bakExists = await fs.access(`${workflowPath}.bak`).then(() => true).catch(() => false);
    expect(bakExists).toBe(true);
  });

  it("diff reports no differences when workflow matches the package default", async () => {
    const tool = makeTool(workspaceDir);
    const workflowPath = path.join(workspaceDir, DATA_DIR, "workflow.yaml");
    await fs.writeFile(workflowPath, WORKFLOW_YAML_TEMPLATE, "utf-8");

    const result = await tool.execute("test-id", { action: "diff" }) as any;
    const r = result?.details ?? result;

    expect(r.success).toBe(true);
    expect(r.summary).toMatch(/no differences/i);
  });

  it("diff reports differences when workflow has been customized", async () => {
    const tool = makeTool(workspaceDir);
    const workflowPath = path.join(workspaceDir, DATA_DIR, "workflow.yaml");
    await fs.writeFile(workflowPath, "initial: custom_state\nstates: {}\n", "utf-8");

    const result = await tool.execute("test-id", { action: "diff" }) as any;
    const r = result?.details ?? result;

    expect(r.success).toBe(true);
    expect(r.differences).toBeGreaterThan(0);
  });

  it("diff reports no-file when workflow.yaml is missing", async () => {
    const tool = makeTool(workspaceDir);

    const result = await tool.execute("test-id", { action: "diff" }) as any;
    const r = result?.details ?? result;

    expect(r.success).toBe(true);
    expect(r.summary).toMatch(/no workflow\.yaml/i);
  });
});
