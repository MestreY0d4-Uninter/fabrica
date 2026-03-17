import { describe, expect, it, vi, beforeEach } from "vitest";
import { InMemoryFabricaRunStore } from "../../lib/github/event-store.js";
import { syncQualityGateForRun } from "../../lib/github/quality-gate.js";

const octokitRequest = vi.fn();

vi.mock("../../lib/github/app-auth.js", () => ({
  getGitHubInstallationOctokit: vi.fn(async (_pluginConfig, installationId: number) => {
    if (!installationId) return null;
    return {
      request: octokitRequest,
    };
  }),
}));

describe("syncQualityGateForRun", () => {
  beforeEach(() => {
    octokitRequest.mockReset();
  });

  it("skips when the event payload lacks repository identity", async () => {
    const runStore = new InMemoryFabricaRunStore();
    const result = await syncQualityGateForRun({
      pluginConfig: {},
      eventRecord: {
        deliveryId: "delivery-1",
        eventName: "pull_request",
        action: "opened",
        installationId: 1,
        repositoryId: 2,
        prNumber: 3,
        headSha: "abc123",
        receivedAt: new Date().toISOString(),
        processedAt: null,
        status: "pending",
        payload: {},
        error: null,
      },
      run: {
        runId: "run-1",
        installationId: 1,
        repositoryId: 2,
        prNumber: 3,
        headSha: "abc123",
        issueRuntimeId: "42",
        state: "running",
        checkRunId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      runStore,
    });

    expect(result).toEqual({
      attempted: false,
      skippedReason: "missing_repo_identity",
    });
  });

  it("creates a check run and persists the checkRunId", async () => {
    const runStore = new InMemoryFabricaRunStore();
    octokitRequest.mockResolvedValue({
      data: { id: 9001 },
    });

    const run = {
      runId: "run-2",
      installationId: 11,
      repositoryId: 22,
      prNumber: 33,
      headSha: "deadbeef",
      issueRuntimeId: "42",
      state: "running" as const,
      checkRunId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await runStore.save(run);

    const result = await syncQualityGateForRun({
      pluginConfig: {},
      eventRecord: {
        deliveryId: "delivery-2",
        eventName: "pull_request",
        action: "opened",
        installationId: 11,
        repositoryId: 22,
        prNumber: 33,
        headSha: "deadbeef",
        receivedAt: new Date().toISOString(),
        processedAt: null,
        status: "pending",
        payload: {
          action: "opened",
          installation: { id: 11 },
          repository: { id: 22, name: "demo", owner: { login: "acme" } },
          pull_request: {
            number: 33,
            head: { sha: "deadbeef" },
            html_url: "https://github.com/acme/demo/pull/33",
          },
        },
        error: null,
      },
      run,
      runStore,
    });

    expect(result).toEqual({
      attempted: true,
      checkRunId: 9001,
    });

    const stored = await runStore.get("run-2");
    expect(stored?.checkRunId).toBe(9001);
    expect(octokitRequest).toHaveBeenCalledTimes(1);
  });

  it("marks failed runs as action_required on an existing check run", async () => {
    const runStore = new InMemoryFabricaRunStore();
    octokitRequest.mockResolvedValue({
      data: { id: 9002 },
    });

    const run = {
      runId: "run-3",
      installationId: 11,
      repositoryId: 22,
      prNumber: 34,
      headSha: "cafebabe",
      issueRuntimeId: "43",
      state: "failed" as const,
      checkRunId: 8123,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await runStore.save(run);

    const result = await syncQualityGateForRun({
      pluginConfig: {},
      eventRecord: {
        deliveryId: "delivery-3",
        eventName: "pull_request_review",
        action: "submitted",
        installationId: 11,
        repositoryId: 22,
        prNumber: 34,
        headSha: "cafebabe",
        receivedAt: new Date().toISOString(),
        processedAt: null,
        status: "pending",
        payload: {
          action: "submitted",
          installation: { id: 11 },
          repository: { id: 22, name: "demo", owner: { login: "acme" } },
          pull_request: {
            number: 34,
            head: { sha: "cafebabe" },
            html_url: "https://github.com/acme/demo/pull/34",
          },
          review: { state: "CHANGES_REQUESTED" },
        },
        error: null,
      },
      run,
      runStore,
    });

    expect(result).toEqual({
      attempted: true,
      checkRunId: 9002,
    });
    expect(octokitRequest).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({
        check_run_id: 8123,
        conclusion: "action_required",
        status: "completed",
      }),
    );
  });

  it("marks gate-approved runs as success so they can satisfy branch protection before merge", async () => {
    const runStore = new InMemoryFabricaRunStore();
    octokitRequest.mockResolvedValue({
      data: { id: 9003 },
    });

    const run = {
      runId: "run-4",
      installationId: 11,
      repositoryId: 22,
      prNumber: 35,
      headSha: "d00df00d",
      issueRuntimeId: "44",
      state: "gate" as const,
      checkRunId: 9002,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await runStore.save(run);

    await syncQualityGateForRun({
      pluginConfig: {},
      eventRecord: {
        deliveryId: "delivery-4",
        eventName: "pull_request_review",
        action: "submitted",
        installationId: 11,
        repositoryId: 22,
        prNumber: 35,
        headSha: "d00df00d",
        receivedAt: new Date().toISOString(),
        processedAt: null,
        status: "pending",
        payload: {
          action: "submitted",
          installation: { id: 11 },
          repository: { id: 22, name: "demo", owner: { login: "acme" } },
          pull_request: {
            number: 35,
            head: { sha: "d00df00d" },
            html_url: "https://github.com/acme/demo/pull/35",
          },
          review: { state: "APPROVED" },
        },
        error: null,
      },
      run,
      runStore,
    });

    expect(octokitRequest).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({
        check_run_id: 9002,
        conclusion: "success",
        status: "completed",
      }),
    );
  });
});
