import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../lib/config/index.js";
import { DATA_DIR } from "../../lib/setup/constants.js";

const LEGACY_DATA_DIR = "devclaw";

let tempDir: string | null = null;

async function makeWorkspace(): Promise<string> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-config-loader-"));
  await fs.mkdir(path.join(tempDir, LEGACY_DATA_DIR), { recursive: true });
  return tempDir;
}

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("loadConfig", () => {
  it("falls back to defaults when workflow.yaml is missing", async () => {
    const ws = await makeWorkspace();
    const config = await loadConfig(ws);
    expect(config.workflow.initial).toBeDefined();
    expect(config.workflow.states).toBeDefined();
  });

  it("fails closed with file context for invalid workflow.yaml", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, DATA_DIR), { recursive: true });
    await fs.writeFile(path.join(ws, DATA_DIR, "workflow.yaml"), "workflow: [", "utf-8");

    await expect(loadConfig(ws)).rejects.toThrow(/workflow\.yaml/);
    await expect(loadConfig(ws)).rejects.toThrow(/Invalid workflow\.yaml|Failed to read workflow\.yaml/);
  });

  it("fails closed with file context for invalid legacy config.yaml", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, "projects"), { recursive: true });
    await fs.writeFile(path.join(ws, "projects", "config.yaml"), "roles: [", "utf-8");

    await expect(loadConfig(ws)).rejects.toThrow(/config\.yaml/);
    await expect(loadConfig(ws)).rejects.toThrow(/legacy config\.yaml/);
  });

  it("fails closed with file context for invalid legacy workflow.json", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, DATA_DIR, "projects"), { recursive: true });
    await fs.writeFile(path.join(ws, DATA_DIR, "projects", "workflow.json"), "{", "utf-8");

    await expect(loadConfig(ws)).rejects.toThrow(/workflow\.json/);
    await expect(loadConfig(ws)).rejects.toThrow(/legacy workflow\.json/);
  });

  it("fails closed for invalid project-level legacy workflow.json", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, DATA_DIR, "projects", "demo"), { recursive: true });
    await fs.writeFile(path.join(ws, DATA_DIR, "projects", "demo", "workflow.json"), "{", "utf-8");

    await expect(loadConfig(ws, "demo")).rejects.toThrow(/legacy workflow\.json/);
    await expect(loadConfig(ws, "demo")).rejects.toThrow(/demo\/workflow\.json/);
  });
});
