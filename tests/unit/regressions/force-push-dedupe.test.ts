import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryFabricaRunStore, InMemoryGitHubEventStore } from "../../../lib/github/event-store.js";
import { processPendingGitHubEvents } from "../../../lib/github/process-events.js";

let workspaceDir: string | null = null;

afterEach(async () => {
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    workspaceDir = null;
  }
});

async function seedWorkspace() {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-regression-"));
  await fs.mkdir(path.join(workspaceDir, "fabrica"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "fabrica", "projects.json"),
    JSON.stringify({
      projects: {
        demo: {
          slug: "demo",
          name: "demo",
          repo: "/tmp/demo",
          repoRemote: "https://github.com/acme/demo.git",
          groupName: "default",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          channels: [],
          provider: "github",
          workers: {},
          issueRuntime: {},
        },
      },
    }, null, 2),
  );
}

describe("force-push regression", () => {
  it("keeps a single FabricaRun per PR across multiple synchronize events", async () => {
    await seedWorkspace();
    const eventStore = new InMemoryGitHubEventStore();
    const runStore = new InMemoryFabricaRunStore();

    await eventStore.saveReceived({
      deliveryId: "delivery-open",
      eventName: "pull_request",
      action: "opened",
      installationId: 101,
      repositoryId: 202,
      prNumber: 7,
      headSha: "abc1234",
      receivedAt: new Date().toISOString(),
      processedAt: null,
      status: "pending",
      payload: {
        action: "opened",
        installation: { id: 101 },
        repository: { id: 202, name: "demo", owner: { login: "acme" } },
        pull_request: {
          number: 7,
          title: "feat: issue #42",
          body: "Implements #42",
          html_url: "https://github.com/acme/demo/pull/7",
          state: "open",
          head: { sha: "abc1234", ref: "feature/42" },
        },
      },
      error: null,
    });
    await eventStore.saveReceived({
      deliveryId: "delivery-sync",
      eventName: "pull_request",
      action: "synchronize",
      installationId: 101,
      repositoryId: 202,
      prNumber: 7,
      headSha: "def5678",
      receivedAt: new Date().toISOString(),
      processedAt: null,
      status: "pending",
      payload: {
        action: "synchronize",
        installation: { id: 101 },
        repository: { id: 202, name: "demo", owner: { login: "acme" } },
        pull_request: {
          number: 7,
          title: "feat: issue #42",
          body: "Implements #42",
          html_url: "https://github.com/acme/demo/pull/7",
          state: "open",
          head: { sha: "def5678", ref: "feature/42" },
        },
      },
      error: null,
    });

    await processPendingGitHubEvents({ workspaceDir: workspaceDir!, eventStore, runStore });
    const runs = await runStore.findByPr(101, 202, 7);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.headSha).toBe("def5678");
  });
});
