import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileFabricaRunStore, FileGitHubEventStore } from "../../lib/github/file-event-store.js";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("file-backed GitHub stores", () => {
  it("persists, lists and marks GitHub events", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-gh-store-"));
    const store = new FileGitHubEventStore(tempDir);

    const first = await store.saveReceived({
      deliveryId: "delivery-1",
      eventName: "pull_request",
      installationId: 1,
      repositoryId: 2,
      prNumber: 3,
      headSha: "abc123",
      receivedAt: new Date().toISOString(),
      processedAt: null,
      status: "pending",
      payload: { hello: "world" },
      error: null,
    });

    expect(first.duplicate).toBe(false);
    const pending = await store.listByStatus(["pending"]);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.deliveryId).toBe("delivery-1");
    expect(pending[0]?.attemptCount).toBe(0);

    const claimed = await store.claimReady();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe("processing");
    expect(claimed[0]?.attemptCount).toBe(1);

    const processed = await store.update("delivery-1", { status: "success", processedAt: new Date().toISOString() });
    expect(processed?.status).toBe("success");
    const successes = await store.listByStatus(["success"]);
    expect(successes).toHaveLength(1);

    const duplicate = await store.saveReceived({
      deliveryId: "delivery-1",
      eventName: "pull_request",
      installationId: 1,
      repositoryId: 2,
      prNumber: 3,
      headSha: "abc123",
      receivedAt: new Date().toISOString(),
      processedAt: null,
      status: "pending",
      payload: { ignored: true },
      error: null,
    });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.record.status).toBe("success");
  });

  it("keeps a single Fabrica run per canonical PR binding", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-gh-run-store-"));
    const store = new FileFabricaRunStore(tempDir);

    await store.save({
      runId: "run-1",
      installationId: 1,
      repositoryId: 2,
      prNumber: 3,
      headSha: "abc123",
      issueRuntimeId: "issue-1",
      state: "running",
      checkRunId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await store.save({
      runId: "run-2",
      installationId: 1,
      repositoryId: 2,
      prNumber: 3,
      headSha: "def456",
      issueRuntimeId: "issue-1",
      state: "waiting_review",
      checkRunId: 99,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const exact = await store.findByPr(1, 2, 3, "abc123");
    expect(exact).toEqual([]);

    const allForPr = await store.findByPr(1, 2, 3);
    expect(allForPr.map((run) => run.runId)).toEqual(["run-2"]);
    expect(allForPr[0]?.headSha).toBe("def456");
  });
});
