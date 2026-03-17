import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scaffoldStep } from "../../lib/intake/steps/scaffold.js";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";

const tempRoots: string[] = [];

async function createRuntimeRoot(): Promise<{ root: string; workspaceDir: string; scriptsDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-scaffold-step-"));
  tempRoots.push(root);
  const workspaceDir = path.join(root, ".openclaw", "workspace");
  const scriptsDir = path.join(root, ".openclaw", "extensions", "fabrica", "genesis", "scripts");
  await fs.mkdir(scriptsDir, { recursive: true });
  await fs.writeFile(path.join(scriptsDir, "scaffold-project.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf-8");
  return { root, workspaceDir, scriptsDir };
}

function basePayload(): GenesisPayload {
  return {
    session_id: "sid-scaffold",
    timestamp: new Date().toISOString(),
    step: "impact",
    raw_idea: "Criar uma CLI Python reproduzivel",
    answers: {},
    metadata: {
      source: "test",
      factory_change: false,
      stack_hint: "python-cli",
    },
    spec: {
      title: "Password CLI",
      type: "feature",
      objective: "Ship a portable password CLI",
      scope_v1: ["Criar comando generate", "Criar comando help"],
      out_of_scope: ["Dashboard web"],
      acceptance_criteria: ["CLI funciona em ambiente limpo"],
      definition_of_done: ["Build e testes verdes"],
      constraints: "Usar Python",
      risks: ["Bootstrap do ambiente"],
      delivery_target: "cli",
    },
    impact: {
      is_greenfield: true,
      affected_files: [],
      affected_modules: [],
      new_files_needed: ["cmd"],
      risk_areas: [],
      estimated_files_changed: 5,
      confidence: "high",
    },
  };
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

describe("scaffoldStep", () => {
  it("builds a scaffold plan in TS and passes it to the shell executor", async () => {
    const { root, workspaceDir, scriptsDir } = await createRuntimeRoot();
    let plannedPayload: GenesisPayload | null = null;
    const repoLocal = path.join(root, "git", "MestreY0d4-Uninter", "password-cli");
    const ctx: StepContext = {
      homeDir: root,
      workspaceDir,
      log: () => {},
      runCommand: async (cmd, args) => {
        if (cmd === "gh") {
          expect(args).toEqual(["api", "user", "-q", ".login"]);
          return { stdout: "MestreY0d4-Uninter\n", stderr: "", exitCode: 0 };
        }
        if (cmd === "bash") {
          expect(args[0]).toBe(path.join(scriptsDir, "scaffold-project.sh"));
          const payloadFile = args[1];
          expect(payloadFile).toBeDefined();
          plannedPayload = JSON.parse(await fs.readFile(payloadFile!, "utf-8")) as GenesisPayload;
          await fs.mkdir(path.join(repoLocal, "src", "password_cli"), { recursive: true });
          await fs.writeFile(path.join(repoLocal, "pyproject.toml"), `
[project]
name = "password-cli"
version = "0.1.0"
[project.optional-dependencies]
dev = ["pytest>=8.0.0"]
`, "utf-8");
          return {
            stdout: JSON.stringify({
              scaffold: {
              created: true,
              stack: "python-cli",
              repo_url: "https://github.com/MestreY0d4-Uninter/password-cli",
              repo_local: repoLocal,
              project_slug: "password-cli",
              files_created: ["README.md", "pyproject.toml"],
            },
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (cmd === "python3" || cmd === "python") {
          return { stdout: "Python 3.11.0\n", stderr: "", exitCode: 0 };
        }
        if (cmd.endsWith("/.venv/bin/python")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        throw new Error(`Unexpected bootstrap command: ${cmd} ${args.join(" ")}`);
      },
    };

    const result = await scaffoldStep.execute(basePayload(), ctx);

    expect(plannedPayload?.metadata.scaffold_plan).toEqual({
      version: 1,
      owner: "MestreY0d4-Uninter",
      repo_name: "password-cli",
      repo_url: "https://github.com/MestreY0d4-Uninter/password-cli",
      repo_local: path.join(root, "git", "MestreY0d4-Uninter", "password-cli"),
      project_slug: "password-cli",
      stack: "python-cli",
      objective: "Ship a portable password CLI",
      delivery_target: "cli",
      repo_target_source: "spec.title",
    });
    expect(plannedPayload?.metadata.repo_url).toBe("https://github.com/MestreY0d4-Uninter/password-cli");
    expect(result.scaffold).toEqual({
      created: true,
      stack: "python-cli",
      repo_url: "https://github.com/MestreY0d4-Uninter/password-cli",
      repo_local: path.join(root, "git", "MestreY0d4-Uninter", "password-cli"),
      project_slug: "password-cli",
      files_created: ["README.md", "pyproject.toml"],
    });
  });

  it("marks the step as failed when the executor returns a non-zero exit code", async () => {
    const { root, workspaceDir, scriptsDir } = await createRuntimeRoot();
    const ctx: StepContext = {
      homeDir: root,
      workspaceDir,
      log: () => {},
      runCommand: async (cmd, args) => {
        if (cmd === "gh") {
          return { stdout: "MestreY0d4-Uninter\n", stderr: "", exitCode: 0 };
        }
        expect(args[0]).toBe(path.join(scriptsDir, "scaffold-project.sh"));
        return {
          stdout: "",
          stderr: "boom",
          exitCode: 1,
        };
      },
    };

    const result = await scaffoldStep.execute(basePayload(), ctx);

    expect(result.scaffold).toEqual({
      created: false,
      reason: "script_failed",
    });
    expect(result.metadata.scaffold_plan?.owner).toBe("MestreY0d4-Uninter");
  });

  it("fails closed when the scaffolded stack diverges from the planned stack", async () => {
    const { root, workspaceDir, scriptsDir } = await createRuntimeRoot();
    const ctx: StepContext = {
      homeDir: root,
      workspaceDir,
      log: () => {},
      runCommand: async (cmd, args) => {
        if (cmd === "gh") {
          return { stdout: "MestreY0d4-Uninter\n", stderr: "", exitCode: 0 };
        }
        expect(args[0]).toBe(path.join(scriptsDir, "scaffold-project.sh"));
        return {
          stdout: JSON.stringify({
            scaffold: {
              created: true,
              stack: "express",
              repo_url: "https://github.com/MestreY0d4-Uninter/password-cli",
              repo_local: path.join(root, "git", "MestreY0d4-Uninter", "password-cli"),
              project_slug: "password-cli",
            },
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    };

    await expect(scaffoldStep.execute({
      ...basePayload(),
      raw_idea: "Criar uma CLI TypeScript reproduzivel",
      metadata: {
        ...basePayload().metadata,
        stack_hint: "node-cli",
      },
      spec: {
        ...basePayload().spec!,
        title: "Password CLI TS",
        objective: "Ship a portable TypeScript CLI",
        constraints: "Usar TypeScript",
      },
    }, ctx)).rejects.toThrow(/materialized stack \"express\" but the planned stack was \"node-cli\"/i);
  });
});
