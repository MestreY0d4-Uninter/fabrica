import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPrDiscoveryPass } from "../../lib/services/heartbeat/pr-discovery.js";
import { InMemoryFabricaRunStore } from "../../lib/github/event-store.js";
import type { Project } from "../../lib/projects/types.js";

// Hoist app-auth mock so all tests in this file use installationId=111 by default.
// Override per-test using vi.mocked(...).mockResolvedValueOnce if needed.
vi.mock("../../lib/github/app-auth.js", () => ({
  getGitHubRepoInstallationOctokit: vi.fn(async () => ({ installationId: 111, octokit: {} })),
}));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    name: "Test Project",
    slug: "test-project",
    repo: "org/repo",
    provider: "github",
    channels: [],
    workers: {
      developer: {
        levels: {
          junior: [
            {
              active: true,
              issueId: "7",
              sessionKey: null,
              startTime: new Date().toISOString(),
              previousLabel: null,
              name: "bot",
              lastIssueId: null,
            },
          ],
        },
      },
    },
    ...overrides,
  } as Project;
}

describe("runPrDiscoveryPass", () => {
  it("makes zero API calls when no active workers", async () => {
    const runStore = new InMemoryFabricaRunStore();
    const provider = { getPrDetails: vi.fn(async () => null) } as any;
    const project = makeProject({
      workers: { developer: { levels: { junior: [{ active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null, name: null, lastIssueId: null }] } } },
    });
    const result = await runPrDiscoveryPass({
      workspaceDir: "/tmp/test",
      projectSlug: "test-project",
      project,
      provider,
      runStore,
      pluginConfig: undefined,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(provider.getPrDetails).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
  });

  it("skips when provider returns null (no PR for issue)", async () => {
    const runStore = new InMemoryFabricaRunStore();
    const provider = { getPrDetails: vi.fn(async () => null) } as any;
    const result = await runPrDiscoveryPass({
      workspaceDir: "/tmp/test",
      projectSlug: "test-project",
      project: makeProject(),
      provider,
      runStore,
      pluginConfig: undefined,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(provider.getPrDetails).toHaveBeenCalledWith(7);
    expect(result.created).toBe(0);
  });

  it("skips when installationId cannot be resolved", async () => {
    const runStore = new InMemoryFabricaRunStore();
    const provider = {
      getPrDetails: vi.fn(async () => ({
        prNumber: 42, headSha: "abc", prState: "open",
        prUrl: null, sourceBranch: "feat", repositoryId: 999,
        owner: "org", repo: "repo",
      })),
    } as any;
    // Override default mock to return null for this test
    const { getGitHubRepoInstallationOctokit } = await import("../../lib/github/app-auth.js");
    vi.mocked(getGitHubRepoInstallationOctokit).mockResolvedValueOnce(null);
    const result = await runPrDiscoveryPass({
      workspaceDir: "/tmp/test",
      projectSlug: "test-project",
      project: makeProject(),
      provider,
      runStore,
      pluginConfig: undefined,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(result.created).toBe(0);
  });

  it("no-op when FabricaRun already exists with same headSha (idempotent)", async () => {
    const runStore = new InMemoryFabricaRunStore();
    // Pre-seed a Run with same headSha
    await runStore.save({
      runId: "111:999:42:abc",
      installationId: 111,
      repositoryId: 999,
      prNumber: 42,
      headSha: "abc",
      issueRuntimeId: "test-project:7",
      state: "planned",
      checkRunId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const provider = {
      getPrDetails: vi.fn(async () => ({
        prNumber: 42, headSha: "abc", prState: "open",
        prUrl: null, sourceBranch: "feat", repositoryId: 999,
        owner: "org", repo: "repo",
      })),
    } as any;

    // Default mock (hoisted) returns installationId=111 — no override needed

    const result = await runPrDiscoveryPass({
      workspaceDir: "/tmp/test",
      projectSlug: "test-project",
      project: makeProject(),
      provider,
      runStore,
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(result.created).toBe(0);  // existing run found, no new creation
    expect(result.updated).toBe(0);  // same headSha, no state change
  });

  it("increments updated when existing run has different headSha (PR_SYNCHRONIZED)", async () => {
    const runStore = new InMemoryFabricaRunStore();
    // Pre-seed a Run with OLD headSha
    await runStore.save({
      runId: "111:999:42:old-sha",
      installationId: 111,
      repositoryId: 999,
      prNumber: 42,
      headSha: "old-sha",
      issueRuntimeId: "test-project:7",
      state: "planned",
      checkRunId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const provider = {
      getPrDetails: vi.fn(async () => ({
        prNumber: 42, headSha: "new-sha", prState: "open",
        prUrl: null, sourceBranch: "feat", repositoryId: 999,
        owner: "org", repo: "repo",
      })),
    } as any;

    // Default mock (hoisted) returns installationId=111 — no override needed

    const result = await runPrDiscoveryPass({
      workspaceDir: "/tmp/test",
      projectSlug: "test-project",
      project: makeProject(),
      provider,
      runStore,
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
  });
});
