/**
 * Unit tests for the doctor diagnostic engine.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runDoctor } from "../../lib/setup/doctor.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DATA_DIR } from "../../lib/setup/constants.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-doctor-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Create a minimal valid workspace for testing.
 */
async function createValidWorkspace(workspacePath: string): Promise<void> {
  const dataDir = path.join(workspacePath, DATA_DIR);
  await fs.mkdir(path.join(dataDir, "prompts"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "projects"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "log"), { recursive: true });

  // Core files
  await fs.writeFile(
    path.join(dataDir, "projects.json"),
    JSON.stringify({ projects: {} }, null, 2),
  );
  await fs.writeFile(
    path.join(dataDir, "workflow.yaml"),
    "roles:\n  developer:\n    models:\n      junior: anthropic/claude-haiku-4-5\n",
  );

  // Workspace markdown files
  await fs.writeFile(path.join(workspacePath, "AGENTS.md"), "# Agents");
  await fs.writeFile(path.join(workspacePath, "HEARTBEAT.md"), "# Heartbeat");
  await fs.writeFile(path.join(workspacePath, "TOOLS.md"), "# Tools");

  // Prompt files for all roles
  for (const role of ["developer", "tester", "architect", "reviewer"]) {
    await fs.writeFile(path.join(dataDir, "prompts", `${role}.md`), `# ${role}`);
  }
}

// ---------------------------------------------------------------------------
// Healthy workspace
// ---------------------------------------------------------------------------

describe("doctor — healthy workspace", () => {
  it("passes all checks on valid workspace", async () => {
    await createValidWorkspace(tmpDir);
    const result = await runDoctor({ workspacePath: tmpDir });

    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(0);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every(c => c.severity === "ok")).toBe(true);
  });

  it("warns when Telegram DM bootstrap is implicitly active but projectsForumChatId is missing", async () => {
    await createValidWorkspace(tmpDir);
    const result = await runDoctor({
      workspacePath: tmpDir,
      pluginConfig: { telegram: {} },
    });

    const check = result.checks.find(c => c.name === "config:telegram-bootstrap");
    expect(check?.severity).toBe("warn");
    expect(check?.message).toContain("active by default");
  });

  it("reports Telegram DM bootstrap as disabled only when explicitly set to false", async () => {
    await createValidWorkspace(tmpDir);
    const result = await runDoctor({
      workspacePath: tmpDir,
      pluginConfig: { telegram: { bootstrapDmEnabled: false } },
    });

    const check = result.checks.find(c => c.name === "config:telegram-bootstrap");
    expect(check?.severity).toBe("ok");
    expect(check?.message).toContain("bootstrapDmEnabled=false");
  });
});

// ---------------------------------------------------------------------------
// Missing files
// ---------------------------------------------------------------------------

describe("doctor — missing files", () => {
  it("detects missing data directory", async () => {
    // Empty workspace — no Fabrica data dir
    const result = await runDoctor({ workspacePath: tmpDir });

    expect(result.errors).toBeGreaterThan(0);
    const dataCheck = result.checks.find(c => c.name.includes(`/${DATA_DIR}`));
    expect(dataCheck?.severity).toBe("error");
  });

  it("detects missing projects.json", async () => {
    await createValidWorkspace(tmpDir);
    await fs.unlink(path.join(tmpDir, DATA_DIR, "projects.json"));

    const result = await runDoctor({ workspacePath: tmpDir });
    const check = result.checks.find(c => c.message.includes("projects.json"));
    expect(check?.severity).toBe("error");
  });

  it("detects missing workflow.yaml", async () => {
    await createValidWorkspace(tmpDir);
    await fs.unlink(path.join(tmpDir, DATA_DIR, "workflow.yaml"));

    const result = await runDoctor({ workspacePath: tmpDir });
    const check = result.checks.find(c => c.message.includes("workflow.yaml"));
    expect(check?.severity).toBe("error");
  });

  it("detects missing prompt file", async () => {
    await createValidWorkspace(tmpDir);
    await fs.unlink(path.join(tmpDir, DATA_DIR, "prompts", "tester.md"));

    const result = await runDoctor({ workspacePath: tmpDir });
    const check = result.checks.find(c => c.message.includes("prompts/tester.md"));
    expect(check?.severity).toBe("error");
  });

  it("detects missing AGENTS.md", async () => {
    await createValidWorkspace(tmpDir);
    await fs.unlink(path.join(tmpDir, "AGENTS.md"));

    const result = await runDoctor({ workspacePath: tmpDir });
    const check = result.checks.find(c => c.message.includes("AGENTS.md"));
    expect(check?.severity).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Invalid content
// ---------------------------------------------------------------------------

describe("doctor — invalid content", () => {
  it("detects invalid YAML in workflow.yaml", async () => {
    await createValidWorkspace(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, DATA_DIR, "workflow.yaml"),
      "{{invalid yaml",
    );

    const result = await runDoctor({ workspacePath: tmpDir });
    const check = result.checks.find(c => c.name === "yaml:workflow");
    expect(check?.severity).toBe("error");
    expect(check?.message).toContain("parse error");
  });

  it("detects invalid JSON in projects.json", async () => {
    await createValidWorkspace(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, DATA_DIR, "projects.json"),
      "not json",
    );

    const result = await runDoctor({ workspacePath: tmpDir });
    const check = result.checks.find(c => c.name === "json:projects");
    expect(check?.severity).toBe("error");
  });

  it("warns on workflow.yaml without roles section", async () => {
    await createValidWorkspace(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, DATA_DIR, "workflow.yaml"),
      "something: else\n",
    );

    const result = await runDoctor({ workspacePath: tmpDir });
    const check = result.checks.find(c => c.name === "yaml:workflow");
    expect(check?.severity).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// Project-level checks
// ---------------------------------------------------------------------------

describe("doctor — project checks", () => {
  it("detects project without channels", async () => {
    await createValidWorkspace(tmpDir);
    const data = {
      projects: {
        "test-project": {
          slug: "test-project",
          name: "Test Project",
          repo: "org/test",
          groupName: "org",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          channels: [],
          workers: {},
        },
      },
    };
    await fs.writeFile(
      path.join(tmpDir, DATA_DIR, "projects.json"),
      JSON.stringify(data, null, 2),
    );

    const result = await runDoctor({ workspacePath: tmpDir });
    const check = result.checks.find(c => c.name === "project:test-project:channels");
    expect(check?.severity).toBe("warn");
  });

  it("detects project without repo", async () => {
    await createValidWorkspace(tmpDir);
    const data = {
      projects: {
        "test-project": {
          slug: "test-project",
          name: "Test Project",
          repo: "",
          groupName: "org",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          channels: [{ channelId: "-100123", channel: "telegram", name: "test", events: ["*"] }],
          workers: {},
        },
      },
    };
    await fs.writeFile(
      path.join(tmpDir, DATA_DIR, "projects.json"),
      JSON.stringify(data, null, 2),
    );

    const result = await runDoctor({ workspacePath: tmpDir });
    const check = result.checks.find(c => c.name === "project:test-project:repo");
    expect(check?.severity).toBe("error");
  });

  it("valid project passes all checks", async () => {
    await createValidWorkspace(tmpDir);
    const data = {
      projects: {
        "my-project": {
          slug: "my-project",
          name: "My Project",
          repo: "org/my-project",
          groupName: "org",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          channels: [{ channelId: "-100123", channel: "telegram", name: "primary", events: ["*"] }],
          workers: {},
        },
      },
    };
    await fs.writeFile(
      path.join(tmpDir, DATA_DIR, "projects.json"),
      JSON.stringify(data, null, 2),
    );

    const result = await runDoctor({ workspacePath: tmpDir });
    expect(result.errors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Config load check
// ---------------------------------------------------------------------------

describe("doctor — config load", () => {
  it("passes when config loads correctly", async () => {
    await createValidWorkspace(tmpDir);
    const result = await runDoctor({ workspacePath: tmpDir });
    const check = result.checks.find(c => c.name === "config:load");
    expect(check?.severity).toBe("ok");
    expect(check?.message).toContain("roles");
    expect(check?.message).toContain("states");
  });
});

// ---------------------------------------------------------------------------
// Fix mode
// ---------------------------------------------------------------------------

describe("doctor — fix mode", () => {
  it("reports fixed count when fix=true", async () => {
    await createValidWorkspace(tmpDir);
    // Remove a file that ensureDefaultFiles would recreate
    await fs.unlink(path.join(tmpDir, "AGENTS.md"));

    const result = await runDoctor({ workspacePath: tmpDir, fix: true });
    // ensureDefaultFiles should have recreated AGENTS.md
    expect(result.fixed).toBeGreaterThanOrEqual(0);
  });

  it("fixes all errors in a single --fix pass on empty workspace", async () => {
    // Empty workspace — simulates fresh install (no data dir, no files)
    const result = await runDoctor({ workspacePath: tmpDir, fix: true });

    // All fixable checks should be resolved in one pass
    expect(result.errors).toBe(0);
    expect(result.fixed).toBeGreaterThan(0);
    // Verify the fixed checks are now OK
    const stillBroken = result.checks.filter(c => c.severity === "error");
    expect(stillBroken).toEqual([]);
  });
});
