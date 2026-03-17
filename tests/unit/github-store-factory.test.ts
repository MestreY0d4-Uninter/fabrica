import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitHubStores } from "../../lib/github/store-factory.js";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("createGitHubStores", () => {
  it("returns file-backed stores when explicitly requested", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-gh-factory-"));
    const stores = await createGitHubStores(tempDir, { backend: "file" });

    expect(stores.backend).toBe("file");
    const saved = await stores.eventStore.saveReceived({
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
    });

    expect(saved.duplicate).toBe(false);
    const listed = await stores.eventStore.listByStatus(["pending"]);
    expect(listed).toHaveLength(1);
  });

  it("creates a working backend with sqlite preferred", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-gh-factory-"));
    const stores = await createGitHubStores(tempDir);

    expect(["sqlite", "file"]).toContain(stores.backend);
    await stores.runStore.save({
      runId: "run-1",
      installationId: 11,
      repositoryId: 22,
      prNumber: 33,
      headSha: "deadbeef",
      issueRuntimeId: "44",
      state: "running",
      checkRunId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const runs = await stores.runStore.findByPr(11, 22, 33, "deadbeef");
    expect(runs.map((run) => run.runId)).toEqual(["run-1"]);
  });
});
