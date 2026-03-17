/**
 * Unit tests for the 3-layer config loader.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../lib/config/loader.js";
import { ROLE_REGISTRY } from "../../lib/roles/registry.js";
import { DEFAULT_WORKFLOW } from "../../lib/workflow/index.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-config-test-"));
  // Create minimal workspace structure
  const dataDir = path.join(tmpDir, "devclaw");
  await fs.mkdir(path.join(dataDir, "projects"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "prompts"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "log"), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "projects.json"),
    JSON.stringify({ projects: {} }),
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Layer 1: Built-in defaults
// ---------------------------------------------------------------------------

describe("config loader — built-in defaults", () => {
  it("returns all registry roles when no yaml exists", async () => {
    const config = await loadConfig(tmpDir);

    for (const roleId of Object.keys(ROLE_REGISTRY)) {
      expect(config.roles[roleId]).toBeDefined();
      expect(config.roles[roleId].enabled).toBe(true);
    }
  });

  it("returns default workflow states", async () => {
    const config = await loadConfig(tmpDir);

    expect(config.workflow.states).toBeDefined();
    expect(Object.keys(config.workflow.states).length).toBeGreaterThan(0);
  });

  it("returns default models from registry", async () => {
    const config = await loadConfig(tmpDir);

    expect(config.roles.developer.models.junior).toBe(
      ROLE_REGISTRY.developer.models.junior,
    );
    expect(config.roles.reviewer.models.senior).toBe(
      ROLE_REGISTRY.reviewer.models.senior,
    );
  });

  it("returns default timeouts", async () => {
    const config = await loadConfig(tmpDir);

    expect(config.timeouts.gitPullMs).toBe(30_000);
    expect(config.timeouts.staleWorkerHours).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Layer 2: Workspace workflow.yaml
// ---------------------------------------------------------------------------

describe("config loader — workspace overrides", () => {
  it("overrides model from workflow.yaml", async () => {
    const yaml = YAML.stringify({
      roles: {
        developer: {
          models: {
            junior: "custom/fast-model",
          },
        },
      },
    });
    await fs.writeFile(path.join(tmpDir, "devclaw", "workflow.yaml"), yaml);

    const config = await loadConfig(tmpDir);
    expect(config.roles.developer.models.junior).toBe("custom/fast-model");
    // Other levels should keep defaults
    expect(config.roles.developer.models.medior).toBe(
      ROLE_REGISTRY.developer.models.medior,
    );
  });

  it("overrides workflow policy", async () => {
    const yaml = YAML.stringify({
      workflow: {
        reviewPolicy: "agent",
        testPolicy: "agent",
      },
    });
    await fs.writeFile(path.join(tmpDir, "devclaw", "workflow.yaml"), yaml);

    const config = await loadConfig(tmpDir);
    expect(config.workflow.reviewPolicy).toBe("agent");
    expect(config.workflow.testPolicy).toBe("agent");
  });

  it("can disable a role", async () => {
    const yaml = YAML.stringify({
      roles: {
        architect: false,
      },
    });
    await fs.writeFile(path.join(tmpDir, "devclaw", "workflow.yaml"), yaml);

    const config = await loadConfig(tmpDir);
    expect(config.roles.architect.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 3: Project overrides
// ---------------------------------------------------------------------------

describe("config loader — project overrides", () => {
  it("overrides model at project level", async () => {
    // Workspace config
    const wsYaml = YAML.stringify({
      roles: {
        developer: {
          models: { junior: "workspace/model" },
        },
      },
    });
    await fs.writeFile(path.join(tmpDir, "devclaw", "workflow.yaml"), wsYaml);

    // Project config
    const projDir = path.join(tmpDir, "devclaw", "projects", "my-project");
    await fs.mkdir(projDir, { recursive: true });
    const projYaml = YAML.stringify({
      roles: {
        developer: {
          models: { junior: "project/model" },
        },
      },
    });
    await fs.writeFile(path.join(projDir, "workflow.yaml"), projYaml);

    const config = await loadConfig(tmpDir, "my-project");
    expect(config.roles.developer.models.junior).toBe("project/model");
  });

  it("project inherits workspace overrides for non-overridden fields", async () => {
    const wsYaml = YAML.stringify({
      roles: {
        developer: {
          models: {
            junior: "workspace/junior",
            medior: "workspace/medior",
          },
        },
      },
    });
    await fs.writeFile(path.join(tmpDir, "devclaw", "workflow.yaml"), wsYaml);

    // Project only overrides junior
    const projDir = path.join(tmpDir, "devclaw", "projects", "my-project");
    await fs.mkdir(projDir, { recursive: true });
    const projYaml = YAML.stringify({
      roles: {
        developer: {
          models: { junior: "project/junior" },
        },
      },
    });
    await fs.writeFile(path.join(projDir, "workflow.yaml"), projYaml);

    const config = await loadConfig(tmpDir, "my-project");
    expect(config.roles.developer.models.junior).toBe("project/junior");
    expect(config.roles.developer.models.medior).toBe("workspace/medior");
  });
});

// ---------------------------------------------------------------------------
// Workflow integrity
// ---------------------------------------------------------------------------

describe("config loader — workflow integrity", () => {
  it("default workflow passes integrity check", async () => {
    const config = await loadConfig(tmpDir);
    // If we got here without error, integrity check passed
    expect(config.workflow.states).toBeDefined();
  });
});
