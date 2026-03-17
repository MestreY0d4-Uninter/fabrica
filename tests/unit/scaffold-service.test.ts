import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildScaffoldPlan,
  parseScaffoldOutput,
} from "../../lib/intake/lib/scaffold-service.js";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";

function makePayload(overrides: Partial<GenesisPayload> = {}): GenesisPayload {
  return {
    session_id: "sid-golden",
    timestamp: "2026-03-14T10:00:00.000Z",
    step: "impact",
    raw_idea: "Criar uma CLI Python portavel",
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
      scope_v1: ["Gerar senha", "Suportar comprimento configuravel"],
      out_of_scope: ["dashboard web"],
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
    ...overrides,
  };
}

function makeCtx(): StepContext {
  return {
    homeDir: "/tmp/fabrica-home",
    workspaceDir: "/tmp/fabrica-home/.openclaw/workspace",
    log: vi.fn(),
    runCommand: vi.fn(async (cmd, args) => {
      expect(cmd).toBe("gh");
      expect(args).toEqual(["api", "user", "-q", ".login"]);
      return { stdout: "MestreY0d4-Uninter\n", stderr: "", exitCode: 0 };
    }),
  };
}

describe("scaffold-service", () => {
  it("builds the canonical scaffold plan for the python-cli golden case", async () => {
    const plan = await buildScaffoldPlan(makePayload(), makeCtx());
    const fixturePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "fixtures",
      "scaffold-plan.stack-cli.json",
    );
    const expected = JSON.parse(await fs.readFile(fixturePath, "utf-8"));

    expect(plan).toEqual(expected);
  });

  it("prefers explicit repo_url targets without needing gh owner resolution", async () => {
    const ctx: StepContext = {
      homeDir: "/tmp/fabrica-home",
      workspaceDir: "/tmp/fabrica-home/.openclaw/workspace",
      log: vi.fn(),
      runCommand: vi.fn(async () => {
        throw new Error("gh should not be called when repo_url is explicit");
      }),
    };

    const plan = await buildScaffoldPlan(
      makePayload({
        metadata: {
          source: "test",
          factory_change: false,
          repo_url: "https://github.com/acme/stack-cli.git",
        },
      }),
      ctx,
    );

    expect(plan.owner).toBe("acme");
    expect(plan.repo_name).toBe("stack-cli");
    expect(plan.repo_url).toBe("https://github.com/acme/stack-cli");
    expect(plan.repo_target_source).toBe("metadata.repo_url");
  });

  it("parses scaffold output contracts with a stable schema", () => {
    const scaffold = parseScaffoldOutput(
      JSON.stringify({
        scaffold: {
          created: true,
          stack: "python-cli",
          repo_url: "https://github.com/MestreY0d4-Uninter/password-cli",
          repo_local: "/tmp/fabrica-home/git/MestreY0d4-Uninter/password-cli",
          project_slug: "password-cli",
          files_created: ["README.md", "pyproject.toml"],
        },
      }),
    );

    expect(scaffold).toEqual({
      created: true,
      stack: "python-cli",
      repo_url: "https://github.com/MestreY0d4-Uninter/password-cli",
      repo_local: "/tmp/fabrica-home/git/MestreY0d4-Uninter/password-cli",
      project_slug: "password-cli",
      files_created: ["README.md", "pyproject.toml"],
    });
  });

  it("fails closed when scaffolded stack diverges from the planned stack", async () => {
    const ctx: StepContext = {
      homeDir: "/tmp/fabrica-home",
      workspaceDir: "/tmp/fabrica-home/.openclaw/workspace",
      log: vi.fn(),
      runCommand: vi.fn(async (cmd, args) => {
        if (cmd === "gh") {
          expect(args).toEqual(["api", "user", "-q", ".login"]);
          return { stdout: "MestreY0d4-Uninter\n", stderr: "", exitCode: 0 };
        }
        if (cmd === "bash") {
          return {
            stdout: JSON.stringify({
              scaffold: {
                created: true,
                stack: "express",
                repo_url: "https://github.com/MestreY0d4-Uninter/password-cli",
                repo_local: "/tmp/fabrica-home/git/MestreY0d4-Uninter/password-cli",
                project_slug: "password-cli",
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error(`Unexpected command: ${cmd}`);
      }),
    };
    const plan = await buildScaffoldPlan(makePayload({
      metadata: {
        source: "test",
        factory_change: false,
        stack_hint: "node-cli",
      },
      raw_idea: "Criar uma CLI TypeScript portavel",
      spec: {
        ...makePayload().spec!,
        title: "Password CLI TS",
        objective: "Ship a portable TypeScript CLI",
        constraints: "Usar TypeScript",
      },
    }), ctx);

    await expect(import("../../lib/intake/lib/scaffold-service.js").then(({ executeScaffoldPlan }) =>
      executeScaffoldPlan(makePayload({
        metadata: {
          source: "test",
          factory_change: false,
          stack_hint: "node-cli",
        },
      }), ctx, plan),
    )).rejects.toThrow(/materialized stack \"express\" but the planned stack was \"node-cli\"/i);
  });

  it("rejects unsupported greenfield scaffold stacks", async () => {
    await expect(buildScaffoldPlan(
      makePayload({
        metadata: {
          source: "test",
          factory_change: false,
          stack_hint: "go",
        },
      }),
      makeCtx(),
    )).rejects.toThrow(/not supported yet/i);
  });
});
