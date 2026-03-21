import { describe, it, expect, vi } from "vitest";
import { syncQualityGate } from "../../lib/github/quality-gate.js";
import type { FabricaRun } from "../../lib/github/types.js";
import type { FabricaRunStore } from "../../lib/github/event-store.js";

const mockRun: FabricaRun = {
  runId: "123:456:42:abc",
  installationId: 123,
  repositoryId: 456,
  prNumber: 42,
  headSha: "abc123",
  issueRuntimeId: "myproject:7",
  state: "planned",
  checkRunId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockRunStore: FabricaRunStore = {
  save: vi.fn(async () => {}),
  get: vi.fn(async () => null),
  findByPr: vi.fn(async () => []),
};

describe("syncQualityGate (core, accepts RepoIdentity)", () => {
  it("is exported from quality-gate.ts", async () => {
    const mod = await import("../../lib/github/quality-gate.js");
    expect(typeof mod.syncQualityGate).toBe("function");
  });

  it("returns skipped when github app is unavailable (no pluginConfig)", async () => {
    const { syncQualityGate } = await import("../../lib/github/quality-gate.js");
    const result = await syncQualityGate({
      pluginConfig: undefined,
      repoIdentity: {
        installationId: 123,
        repositoryId: 456,
        owner: "org",
        repo: "myrepo",
        headSha: "abc123",
      },
      run: mockRun,
      runStore: mockRunStore,
      source: "polling",
      deliveryId: "poll-12345-7",
    });
    expect(result.attempted).toBe(false);
    expect(result.skippedReason).toBe("github_app_unavailable");
  });

  it("syncQualityGateForRun (wrapper) still exported", async () => {
    const mod = await import("../../lib/github/quality-gate.js");
    expect(typeof mod.syncQualityGateForRun).toBe("function");
  });
});
