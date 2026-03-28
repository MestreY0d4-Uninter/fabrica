import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapProjectStep } from "../../lib/intake/steps/map-project.js";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";
import { writeProjects } from "../../lib/projects/io.js";
import type { ProjectsData } from "../../lib/projects/types.js";
import { DATA_DIR } from "../../lib/setup/constants.js";

const tempDirs: string[] = [];

async function createWorkspace(projects: ProjectsData): Promise<{ workspaceDir: string; homeDir: string }> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-home-"));
  const workspaceDir = path.join(homeDir, ".openclaw", "workspace");
  const dataDir = path.join(workspaceDir, DATA_DIR);
  await fs.mkdir(dataDir, { recursive: true });
  await writeProjects(workspaceDir, projects);
  tempDirs.push(homeDir);
  return { workspaceDir, homeDir };
}

function makeCtx(workspaceDir: string, homeDir: string): StepContext {
  return {
    runCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    log: vi.fn(),
    workspaceDir,
    homeDir,
  };
}

function makePayload(overrides: Partial<GenesisPayload> = {}): GenesisPayload {
  return {
    session_id: "sess-map",
    timestamp: "2026-03-13T00:00:00Z",
    step: "spec",
    raw_idea: "Melhorar Stack CLI",
    answers: {},
    metadata: {
      source: "test",
      factory_change: false,
    },
    spec: {
      title: "Stack CLI follow-up",
      type: "feature",
      objective: "Improve the CLI",
      scope_v1: ["Adicionar stack update"],
      out_of_scope: [],
      acceptance_criteria: ["Existe comando stack update funcional"],
      definition_of_done: ["Tests pass"],
      constraints: "Delivery target: cli.",
      risks: [],
      delivery_target: "cli",
    },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("mapProjectStep", () => {
  it("treats intake as greenfield when no target is resolved", async () => {
    const { workspaceDir, homeDir } = await createWorkspace({ projects: {} });

    const result = await mapProjectStep.execute(makePayload(), makeCtx(workspaceDir, homeDir));

    expect(result.project_map?.is_greenfield).toBe(true);
    expect(result.project_map?.confidence).toBe("high");
    expect(result.project_map?.symbols).toEqual([]);
    expect(result.metadata.project_slug).toBeNull();
  });

  it("resolves a registered project from answers.repo_target and scans the local repo", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-repo-"));
    tempDirs.push(repoDir);
    await fs.mkdir(path.join(repoDir, "cmd", "stack"), { recursive: true });
    await fs.mkdir(path.join(repoDir, "internal", "lock"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "cmd", "stack", "main.go"), "package main\nfunc main() {}\n", "utf-8");
    await fs.writeFile(path.join(repoDir, "internal", "lock", "resolver.go"), "package lock\n", "utf-8");
    await fs.writeFile(path.join(repoDir, "flake.nix"), "{ }", "utf-8");

    const projects: ProjectsData = {
      projects: {
        "stack-cli": {
          slug: "stack-cli",
          name: "Stack CLI",
          repo: repoDir,
          repoRemote: "https://github.com/acme/stack-cli.git",
          groupName: "Acme",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          channels: [],
          provider: "github",
          workers: {},
        },
      },
    };
    const { workspaceDir, homeDir } = await createWorkspace(projects);

    const result = await mapProjectStep.execute(
      makePayload({
        answers: {
          repo_target: "stack-cli",
        },
      }),
      makeCtx(workspaceDir, homeDir),
    );

    expect(result.metadata.project_slug).toBe("stack-cli");
    expect(result.metadata.repo_target_source).toBe("answers.repo_target");
    expect(result.metadata.repo_path).toBe(repoDir);
    expect(result.project_map?.is_greenfield).toBe(false);
    expect(result.project_map?.stats.languages).toContain("Go");
    expect(result.project_map?.stats.languages).toContain("Nix");
    expect(result.project_map?.modules).toContain("cmd");
    expect(result.project_map?.symbols.some((symbol) => symbol.name === "main")).toBe(true);
  });

  it("blocks reserved Fabrica projects unless factory_change is enabled", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-core-"));
    tempDirs.push(repoDir);
    const projects: ProjectsData = {
      projects: {
        "fabrica-core": {
          slug: "fabrica-core",
          name: "Fabrica Core",
          repo: repoDir,
          repoRemote: "https://github.com/acme/fabrica-core.git",
          groupName: "Acme",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          channels: [],
          provider: "github",
          workers: {},
        },
      },
    };
    const { workspaceDir, homeDir } = await createWorkspace(projects);

    await expect(
      mapProjectStep.execute(
        makePayload({
          answers: {
            repo_target: "fabrica-core",
          },
        }),
        makeCtx(workspaceDir, homeDir),
      ),
    ).rejects.toThrow(/reserved for Fabrica-internal changes/i);
  });
});
