import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";

const {
  mockBuildScaffoldPlan,
  mockEnsureRepositoryProvisioning,
} = vi.hoisted(() => ({
  mockBuildScaffoldPlan: vi.fn(),
  mockEnsureRepositoryProvisioning: vi.fn(),
}));

vi.mock("../../lib/intake/lib/scaffold-service.js", () => ({
  buildScaffoldPlan: mockBuildScaffoldPlan,
}));

vi.mock("../../lib/intake/lib/repository-provision-service.js", () => ({
  ensureRepositoryProvisioning: mockEnsureRepositoryProvisioning,
}));

import { provisionRepoStep } from "../../lib/intake/steps/provision-repo.js";

function basePayload(): GenesisPayload {
  return {
    session_id: "sid-provision",
    timestamp: new Date().toISOString(),
    step: "qa-contract",
    raw_idea: "Criar uma CLI Python para gerar senhas",
    answers: {},
    metadata: {
      source: "telegram-dm-bootstrap",
      factory_change: false,
      project_name: "password-cli",
      stack_hint: "python-cli",
    },
    impact: {
      is_greenfield: true,
      affected_files: [],
      affected_modules: [],
      new_files_needed: ["src"],
      risk_areas: [],
      estimated_files_changed: 4,
      confidence: "high",
    },
    project_map: {
      version: "1",
      project: "password-cli",
      root: null,
      repo_url: null,
      is_greenfield: true,
      confidence: "high",
      project_slug: "password-cli",
      project_kind: "greenfield",
      stats: {
        languages: [],
        symbol_count: 0,
      },
      symbols: [],
    },
    spec: {
      title: "Password CLI",
      type: "feature",
      objective: "Ship a simple password generator",
      scope_v1: ["generate"],
      out_of_scope: [],
      acceptance_criteria: ["works"],
      definition_of_done: ["tests green"],
      constraints: "Use Python",
      risks: [],
      delivery_target: "cli",
    },
  };
}

describe("provisionRepoStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildScaffoldPlan.mockResolvedValue({
      version: 1,
      owner: "MestreY0d4-Uninter",
      repo_name: "password-cli",
      repo_url: "https://github.com/MestreY0d4-Uninter/password-cli",
      repo_local: "/home/mateus/git/MestreY0d4-Uninter/password-cli",
      project_slug: "password-cli",
      stack: "python-cli",
      objective: "Ship a simple password generator",
      delivery_target: "cli",
      repo_target_source: "metadata.project_name",
    });
    mockEnsureRepositoryProvisioning.mockResolvedValue({
      ready: true,
      mode: "greenfield",
      repo_url: "https://github.com/MestreY0d4-Uninter/password-cli",
      repo_local: "/home/mateus/git/MestreY0d4-Uninter/password-cli",
      default_branch: "main",
      created: true,
      cloned: true,
      seeded: false,
      provider: "github",
    });
  });

  it("builds a plan and persists repository metadata for greenfield intake", async () => {
    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };

    const result = await provisionRepoStep.execute(basePayload(), ctx);

    expect(mockBuildScaffoldPlan).toHaveBeenCalledTimes(1);
    expect(mockEnsureRepositoryProvisioning).toHaveBeenCalledTimes(1);
    expect(result.provisioning).toEqual(expect.objectContaining({
      repo_url: "https://github.com/MestreY0d4-Uninter/password-cli",
      repo_local: "/home/mateus/git/MestreY0d4-Uninter/password-cli",
      provider: "github",
    }));
    expect(result.metadata.repo_url).toBe("https://github.com/MestreY0d4-Uninter/password-cli");
    expect(result.metadata.repo_path).toBe("/home/mateus/git/MestreY0d4-Uninter/password-cli");
    expect(result.metadata.project_slug).toBe("password-cli");
    expect(result.metadata.repo_provisioned).toBe(true);
  });

  it("reuses a precomputed scaffold plan when present", async () => {
    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };
    const payload = basePayload();
    payload.metadata.scaffold_plan = await mockBuildScaffoldPlan();
    mockBuildScaffoldPlan.mockClear();

    await provisionRepoStep.execute(payload, ctx);

    expect(mockBuildScaffoldPlan).not.toHaveBeenCalled();
    expect(mockEnsureRepositoryProvisioning).toHaveBeenCalledTimes(1);
  });

  it("fails closed when provisioning does not produce a ready repository", async () => {
    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };
    mockEnsureRepositoryProvisioning.mockResolvedValueOnce({
      ready: false,
      mode: "greenfield",
      repo_url: "https://github.com/MestreY0d4-Uninter/password-cli",
      repo_local: "/home/mateus/git/MestreY0d4-Uninter/password-cli",
      default_branch: "main",
      created: false,
      cloned: false,
      seeded: false,
      provider: "github",
      reason: "local_repo_origin_mismatch",
    });

    await expect(provisionRepoStep.execute(basePayload(), ctx)).rejects.toThrow(
      /Repository provisioning failed: local_repo_origin_mismatch/,
    );
  });
});
