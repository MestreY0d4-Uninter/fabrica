import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";

const {
  mockEnsureRepository,
  mockProviderCtorArgs,
} = vi.hoisted(() => ({
  mockEnsureRepository: vi.fn(),
  mockProviderCtorArgs: [] as Array<{ repoPath: string }>,
}));

vi.mock("../../lib/intake/lib/scaffold-service.js", () => ({
  buildScaffoldPlan: vi.fn(),
}));

vi.mock("../../lib/providers/github.js", () => ({
  GitHubProvider: class {
    constructor(public opts: { repoPath: string }) {
      mockProviderCtorArgs.push(opts);
    }
    ensureRepository = mockEnsureRepository;
  },
}));

import { ensureRepositoryProvisioning } from "../../lib/intake/lib/repository-provision-service.js";

function makePayload(overrides: Partial<GenesisPayload> = {}): GenesisPayload {
  return {
    session_id: "sid-provision-service",
    timestamp: new Date().toISOString(),
    step: "map-project",
    raw_idea: "Reuse a remote repository",
    answers: {},
    metadata: {
      source: "test",
      factory_change: false,
      repo_url: "https://github.com/acme/demo-cli",
    },
    project_map: {
      version: "1",
      project: "demo-cli",
      root: null,
      repo_url: "https://github.com/acme/demo-cli.git",
      is_greenfield: false,
      remote_only: true,
      confidence: "high",
      project_slug: null,
      project_kind: "implementation",
      stats: {
        languages: [],
        symbol_count: 0,
      },
      symbols: [],
    },
    ...overrides,
  };
}

function makeCtx(): StepContext {
  return {
    workspaceDir: "/tmp/workspace",
    homeDir: "/tmp/home",
    log: vi.fn(),
    runCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  };
}

describe("repository-provision-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProviderCtorArgs.length = 0;
    mockEnsureRepository.mockImplementation(async (request: { remoteUrl: string }) => ({
      repoUrl: request.remoteUrl,
      repoPath: mockProviderCtorArgs.at(-1)?.repoPath ?? "/tmp/home/git/demo-cli",
      defaultBranch: "main",
      created: true,
      cloned: true,
      seeded: false,
    }));
  });

  it("uses the repo-name checkout layout for remote-only targets", async () => {
    const result = await ensureRepositoryProvisioning(makePayload(), makeCtx());

    expect(mockEnsureRepository).toHaveBeenCalledWith(expect.objectContaining({
      owner: "acme",
      name: "demo-cli",
      remoteUrl: "https://github.com/acme/demo-cli",
    }));
    expect(mockProviderCtorArgs[0]?.repoPath).toBe("/tmp/home/git/acme/demo-cli");
    expect(result.repo_local).toBe("/tmp/home/git/acme/demo-cli");
  });

  it("does not collide remote-only local paths for different owners sharing the same repo name", async () => {
    const ctx = makeCtx();

    const acmeResult = await ensureRepositoryProvisioning(makePayload(), ctx);
    const otherResult = await ensureRepositoryProvisioning(makePayload({
      metadata: {
        source: "test",
        factory_change: false,
        repo_url: "https://github.com/other-org/demo-cli",
      },
      project_map: {
        ...makePayload().project_map!,
        repo_url: "https://github.com/other-org/demo-cli.git",
      },
    }), ctx);

    expect(mockEnsureRepository).toHaveBeenNthCalledWith(1, expect.objectContaining({
      owner: "acme",
      name: "demo-cli",
    }));
    expect(mockEnsureRepository).toHaveBeenNthCalledWith(2, expect.objectContaining({
      owner: "other-org",
      name: "demo-cli",
    }));
    expect(mockProviderCtorArgs[0]?.repoPath).toBe("/tmp/home/git/acme/demo-cli");
    expect(mockProviderCtorArgs[1]?.repoPath).toBe("/tmp/home/git/other-org/demo-cli");
    expect(acmeResult.repo_local).toBe("/tmp/home/git/acme/demo-cli");
    expect(otherResult.repo_local).toBe("/tmp/home/git/other-org/demo-cli");
    expect(acmeResult.repo_local).not.toBe(otherResult.repo_local);
  });
});
