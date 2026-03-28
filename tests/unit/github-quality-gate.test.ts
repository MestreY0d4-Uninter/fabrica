import { describe, expect, it, vi, beforeEach } from "vitest";
import { InMemoryFabricaRunStore } from "../../lib/github/event-store.js";
import { syncQualityGateForRun } from "../../lib/github/quality-gate.js";

// Mock execa so gh CLI calls are intercepted
const execaMock = vi.fn();
vi.mock("execa", () => ({
  execa: execaMock,
}));

describe("syncQualityGateForRun", () => {
  beforeEach(() => {
    execaMock.mockReset();
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
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("creates a check run via gh CLI and persists the checkRunId", async () => {
    const runStore = new InMemoryFabricaRunStore();
    execaMock.mockResolvedValue({
      stdout: JSON.stringify({ id: 9001 }),
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
    expect(execaMock).toHaveBeenCalledTimes(1);
    // Verify gh CLI was called to create a check run (POST)
    expect(execaMock).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["api", "repos/acme/demo/check-runs", "--method", "POST"]),
      expect.any(Object),
    );
  });

  it("marks failed runs as action_required on an existing check run via gh CLI PATCH", async () => {
    const runStore = new InMemoryFabricaRunStore();
    execaMock.mockResolvedValue({
      stdout: JSON.stringify({ id: 9002 }),
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
    // Verify gh CLI was called to PATCH the existing check run
    expect(execaMock).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["api", "repos/acme/demo/check-runs/8123", "--method", "PATCH"]),
      expect.any(Object),
    );
    // Verify the body passed to gh includes action_required conclusion
    const callArgs = execaMock.mock.calls[0];
    const input = JSON.parse(callArgs[2].input as string) as Record<string, unknown>;
    expect(input.conclusion).toBe("action_required");
    expect(input.status).toBe("completed");
  });

  it("marks gate-approved runs as success via gh CLI so they satisfy branch protection", async () => {
    const runStore = new InMemoryFabricaRunStore();
    execaMock.mockResolvedValue({
      stdout: JSON.stringify({ id: 9003 }),
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

    // Verify the body passed to gh includes success conclusion
    const callArgs = execaMock.mock.calls[0];
    expect(callArgs[1]).toContain("repos/acme/demo/check-runs/9002");
    const input = JSON.parse(callArgs[2].input as string) as Record<string, unknown>;
    expect(input.conclusion).toBe("success");
    expect(input.status).toBe("completed");
  });
});
