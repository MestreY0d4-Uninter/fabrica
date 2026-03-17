import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryFabricaRunStore, InMemoryGitHubEventStore } from "../../lib/github/event-store.js";
import { processPendingGitHubEvents } from "../../lib/github/process-events.js";
import { readProjects } from "../../lib/projects/io.js";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function writeWorkspaceProjects(workspaceDir: string) {
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

describe("processPendingGitHubEvents", () => {
  it("creates a FabricaRun and updates issueRuntime from a pull_request event", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-gh-process-"));
    await writeWorkspaceProjects(tempDir);

    const eventStore = new InMemoryGitHubEventStore();
    const runStore = new InMemoryFabricaRunStore();
    await eventStore.saveReceived({
      deliveryId: "delivery-1",
      eventName: "pull_request",
      action: "opened",
      installationId: 101,
      repositoryId: 202,
      prNumber: 7,
      headSha: "abc123",
      receivedAt: new Date().toISOString(),
      processedAt: null,
      status: "pending",
      payload: {
        action: "opened",
        installation: { id: 101 },
        repository: { id: 202, name: "demo", owner: { login: "acme" } },
        pull_request: {
          number: 7,
          title: "feat: add stack init (#42)",
          body: "Implements the initial flow for #42",
          html_url: "https://github.com/acme/demo/pull/7",
          state: "open",
          head: { sha: "abc123", ref: "feature/42-init" },
        },
      },
      error: null,
    });

    const result = await processPendingGitHubEvents({
      workspaceDir: tempDir,
      eventStore,
      runStore,
    });

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    const runs = await runStore.findByPr(101, 202, 7, "abc123");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.issueRuntimeId).toBe("42");
    expect(runs[0]?.state).toBe("running");

    const projects = await readProjects(tempDir);
    expect(projects.projects.demo?.issueRuntime?.["42"]).toMatchObject({
      currentPrNumber: 7,
      currentPrIssueTarget: 42,
      currentPrState: "open",
      bindingSource: "explicit",
      bindingConfidence: "high",
    });

    const record = await eventStore.get("delivery-1");
    expect(record?.status).toBe("success");
  });

  it("moves review events into repairing when changes are requested", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-gh-process-"));
    await writeWorkspaceProjects(tempDir);

    const eventStore = new InMemoryGitHubEventStore();
    const runStore = new InMemoryFabricaRunStore();
    await eventStore.saveReceived({
      deliveryId: "delivery-2",
      eventName: "pull_request_review",
      action: "submitted",
      installationId: 101,
      repositoryId: 202,
      prNumber: 8,
      headSha: "def456",
      receivedAt: new Date().toISOString(),
      processedAt: null,
      status: "pending",
      payload: {
        action: "submitted",
        installation: { id: 101 },
        repository: { id: 202, name: "demo", owner: { login: "acme" } },
        pull_request: {
          number: 8,
          title: "fix: follow up for #42",
          body: "Follow-up for issue #42",
          html_url: "https://github.com/acme/demo/pull/8",
          head: { sha: "def456", ref: "feature/42-fix" },
        },
        review: { state: "CHANGES_REQUESTED" },
      },
      error: null,
    });

    const result = await processPendingGitHubEvents({
      workspaceDir: tempDir,
      eventStore,
      runStore,
    });

    expect(result.processed).toBe(1);
    const runs = await runStore.findByPr(101, 202, 8, "def456");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("repairing");
  });

  it("marks approved review events as gate runs", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-gh-process-"));
    await writeWorkspaceProjects(tempDir);

    const eventStore = new InMemoryGitHubEventStore();
    const runStore = new InMemoryFabricaRunStore();
    await eventStore.saveReceived({
      deliveryId: "delivery-2a",
      eventName: "pull_request_review",
      action: "submitted",
      installationId: 101,
      repositoryId: 202,
      prNumber: 8,
      headSha: "def999",
      receivedAt: new Date().toISOString(),
      processedAt: null,
      status: "pending",
      payload: {
        action: "submitted",
        installation: { id: 101 },
        repository: { id: 202, name: "demo", owner: { login: "acme" } },
        pull_request: {
          number: 8,
          title: "fix: follow up for #42",
          body: "Follow-up for issue #42",
          html_url: "https://github.com/acme/demo/pull/8",
          head: { sha: "def999", ref: "feature/42-fix" },
        },
        review: { state: "APPROVED" },
      },
      error: null,
    });

    const result = await processPendingGitHubEvents({
      workspaceDir: tempDir,
      eventStore,
      runStore,
    });

    expect(result.processed).toBe(1);
    const runs = await runStore.findByPr(101, 202, 8, "def999");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("gate");
  });

  it("marks approved reviews as gate runs so the PR becomes gate-eligible", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-gh-process-"));
    await writeWorkspaceProjects(tempDir);

    const eventStore = new InMemoryGitHubEventStore();
    const runStore = new InMemoryFabricaRunStore();
    await eventStore.saveReceived({
      deliveryId: "delivery-2b",
      eventName: "pull_request_review",
      action: "submitted",
      installationId: 101,
      repositoryId: 202,
      prNumber: 8,
      headSha: "def789",
      receivedAt: new Date().toISOString(),
      processedAt: null,
      status: "pending",
      payload: {
        action: "submitted",
        installation: { id: 101 },
        repository: { id: 202, name: "demo", owner: { login: "acme" } },
        pull_request: {
          number: 8,
          title: "fix: follow up for #42",
          body: "Follow-up for issue #42",
          html_url: "https://github.com/acme/demo/pull/8",
          head: { sha: "def789", ref: "feature/42-fix" },
        },
        review: { state: "APPROVED" },
      },
      error: null,
    });

    const result = await processPendingGitHubEvents({
      workspaceDir: tempDir,
      eventStore,
      runStore,
    });

    expect(result.processed).toBe(1);
    const runs = await runStore.findByPr(101, 202, 8, "def789");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("gate");
  });

  it("records artifactOfRecord when a pull request is merged", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-gh-process-"));
    await writeWorkspaceProjects(tempDir);

    const eventStore = new InMemoryGitHubEventStore();
    const runStore = new InMemoryFabricaRunStore();
    await eventStore.saveReceived({
      deliveryId: "delivery-3",
      eventName: "pull_request",
      action: "closed",
      installationId: 101,
      repositoryId: 202,
      prNumber: 9,
      headSha: "feedface",
      receivedAt: new Date().toISOString(),
      processedAt: null,
      status: "pending",
      payload: {
        action: "closed",
        installation: { id: 101 },
        repository: { id: 202, name: "demo", owner: { login: "acme" } },
        pull_request: {
          number: 9,
          title: "feat: ship stack workflow (#42)",
          body: "Closes #42",
          html_url: "https://github.com/acme/demo/pull/9",
          state: "closed",
          merged: true,
          merged_at: "2026-03-13T12:00:00Z",
          head: { sha: "feedface", ref: "feature/42-ship" },
        },
      },
      error: null,
    });

    const result = await processPendingGitHubEvents({
      workspaceDir: tempDir,
      eventStore,
      runStore,
    });

    expect(result.processed).toBe(1);
    const runs = await runStore.findByPr(101, 202, 9, "feedface");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("passed");

    const projects = await readProjects(tempDir);
    expect(projects.projects.demo?.issueRuntime?.["42"]).toMatchObject({
      currentPrNumber: 9,
      currentPrState: "merged",
      currentPrInstallationId: 101,
      currentPrRepositoryId: 202,
      currentPrHeadSha: "feedface",
      lastHeadSha: "feedface",
      lastGitHubDeliveryId: "delivery-3",
      artifactOfRecord: {
        prNumber: 9,
        headSha: "feedface",
        url: "https://github.com/acme/demo/pull/9",
      },
    });
  });

  it("retries malformed webhook payloads and eventually dead-letters them", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-gh-process-"));
    await writeWorkspaceProjects(tempDir);

    const eventStore = new InMemoryGitHubEventStore();
    const runStore = new InMemoryFabricaRunStore();
    await eventStore.saveReceived({
      deliveryId: "delivery-bad-1",
      eventName: "pull_request",
      action: "opened",
      installationId: 101,
      repositoryId: 202,
      prNumber: 10,
      headSha: "badbad",
      receivedAt: new Date().toISOString(),
      processedAt: null,
      status: "pending",
      payload: {
        action: "opened",
        installation: { id: 101 },
        repository: { id: 202, name: "demo", owner: { login: "acme" } },
        pull_request: {
          number: "not-a-number",
          head: { sha: "badbad" },
        },
      },
      error: null,
    } as any);

    for (let index = 0; index < 5; index += 1) {
      await processPendingGitHubEvents({
        workspaceDir: tempDir,
        eventStore,
        runStore,
      });
      const record = await eventStore.get("delivery-bad-1");
      expect(record).not.toBeNull();
      if (index < 4) {
        expect(record?.deadLetter).toBe(false);
        expect(record?.status).toBe("failed");
      } else {
        expect(record?.deadLetter).toBe(true);
        expect(record?.status).toBe("failed");
        expect(record?.attemptCount).toBe(5);
      }

      await eventStore.update("delivery-bad-1", { nextAttemptAt: null });
    }
  });

  it("keeps the canonical binding across force-pushes and updates the head sha", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-gh-process-"));
    await writeWorkspaceProjects(tempDir);

    const eventStore = new InMemoryGitHubEventStore();
    const runStore = new InMemoryFabricaRunStore();
    await eventStore.saveReceived({
      deliveryId: "delivery-4a",
      eventName: "pull_request",
      action: "opened",
      installationId: 101,
      repositoryId: 202,
      prNumber: 11,
      headSha: "aaaa1111",
      receivedAt: new Date().toISOString(),
      processedAt: null,
      status: "pending",
      payload: {
        action: "opened",
        installation: { id: 101 },
        repository: { id: 202, name: "demo", owner: { login: "acme" } },
        pull_request: {
          number: 11,
          title: "feat: ship stack flow (#42)",
          body: "Implements #42",
          html_url: "https://github.com/acme/demo/pull/11",
          state: "open",
          head: { sha: "aaaa1111", ref: "feature/42-stack" },
        },
      },
      error: null,
    });

    await processPendingGitHubEvents({
      workspaceDir: tempDir,
      eventStore,
      runStore,
    });

    await eventStore.saveReceived({
      deliveryId: "delivery-4b",
      eventName: "pull_request",
      action: "synchronize",
      installationId: 101,
      repositoryId: 202,
      prNumber: 11,
      headSha: "bbbb2222",
      receivedAt: new Date().toISOString(),
      processedAt: null,
      status: "pending",
      payload: {
        action: "synchronize",
        installation: { id: 101 },
        repository: { id: 202, name: "demo", owner: { login: "acme" } },
        pull_request: {
          number: 11,
          title: "feat: ship stack flow",
          body: "",
          html_url: "https://github.com/acme/demo/pull/11",
          state: "open",
          head: { sha: "bbbb2222", ref: "feature/42-stack" },
        },
      },
      error: null,
    });

    const result = await processPendingGitHubEvents({
      workspaceDir: tempDir,
      eventStore,
      runStore,
    });

    expect(result.processed).toBe(1);
    const projects = await readProjects(tempDir);
    expect(projects.projects.demo?.issueRuntime?.["42"]).toMatchObject({
      currentPrNumber: 11,
      currentPrHeadSha: "bbbb2222",
      lastHeadSha: "bbbb2222",
    });
  });

  it("releases the old binding when a PR is retargeted to a different issue", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-gh-process-"));
    await writeWorkspaceProjects(tempDir);

    const eventStore = new InMemoryGitHubEventStore();
    const runStore = new InMemoryFabricaRunStore();
    await eventStore.saveReceived({
      deliveryId: "delivery-5a",
      eventName: "pull_request",
      action: "opened",
      installationId: 101,
      repositoryId: 202,
      prNumber: 12,
      headSha: "cccc3333",
      receivedAt: new Date().toISOString(),
      processedAt: null,
      status: "pending",
      payload: {
        action: "opened",
        installation: { id: 101 },
        repository: { id: 202, name: "demo", owner: { login: "acme" } },
        pull_request: {
          number: 12,
          title: "feat: initial slice (#42)",
          body: "Implements #42",
          html_url: "https://github.com/acme/demo/pull/12",
          state: "open",
          head: { sha: "cccc3333", ref: "feature/42-slice" },
        },
      },
      error: null,
    });
    await processPendingGitHubEvents({
      workspaceDir: tempDir,
      eventStore,
      runStore,
    });

    await eventStore.saveReceived({
      deliveryId: "delivery-5b",
      eventName: "pull_request",
      action: "synchronize",
      installationId: 101,
      repositoryId: 202,
      prNumber: 12,
      headSha: "dddd4444",
      receivedAt: new Date().toISOString(),
      processedAt: null,
      status: "pending",
      payload: {
        action: "synchronize",
        installation: { id: 101 },
        repository: { id: 202, name: "demo", owner: { login: "acme" } },
        pull_request: {
          number: 12,
          title: "feat: retarget this work (#99)",
          body: "Now targets #99",
          html_url: "https://github.com/acme/demo/pull/12",
          state: "open",
          head: { sha: "dddd4444", ref: "feature/99-slice" },
        },
      },
      error: null,
    });

    await processPendingGitHubEvents({
      workspaceDir: tempDir,
      eventStore,
      runStore,
    });

    const projects = await readProjects(tempDir);
    expect(projects.projects.demo?.issueRuntime?.["42"]).toMatchObject({
      currentPrNumber: null,
      followUpPrRequired: true,
      lastRejectedPrNumber: 12,
    });
    expect(projects.projects.demo?.issueRuntime?.["99"]).toMatchObject({
      currentPrNumber: 12,
      currentPrIssueTarget: 99,
    });
  });

  it("refuses to steal the canonical binding when a second PR opens for the same issue", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-gh-process-"));
    await writeWorkspaceProjects(tempDir);

    const eventStore = new InMemoryGitHubEventStore();
    const runStore = new InMemoryFabricaRunStore();
    await eventStore.saveReceived({
      deliveryId: "delivery-6a",
      eventName: "pull_request",
      action: "opened",
      installationId: 101,
      repositoryId: 202,
      prNumber: 13,
      headSha: "eeee5555",
      receivedAt: new Date().toISOString(),
      processedAt: null,
      status: "pending",
      payload: {
        action: "opened",
        installation: { id: 101 },
        repository: { id: 202, name: "demo", owner: { login: "acme" } },
        pull_request: {
          number: 13,
          title: "feat: primary slice (#42)",
          body: "Implements #42",
          html_url: "https://github.com/acme/demo/pull/13",
          state: "open",
          head: { sha: "eeee5555", ref: "feature/42-primary" },
        },
      },
      error: null,
    });
    await processPendingGitHubEvents({
      workspaceDir: tempDir,
      eventStore,
      runStore,
    });

    await eventStore.saveReceived({
      deliveryId: "delivery-6b",
      eventName: "pull_request",
      action: "opened",
      installationId: 101,
      repositoryId: 202,
      prNumber: 14,
      headSha: "ffff6666",
      receivedAt: new Date().toISOString(),
      processedAt: null,
      status: "pending",
      payload: {
        action: "opened",
        installation: { id: 101 },
        repository: { id: 202, name: "demo", owner: { login: "acme" } },
        pull_request: {
          number: 14,
          title: "feat: competing slice (#42)",
          body: "Also references #42",
          html_url: "https://github.com/acme/demo/pull/14",
          state: "open",
          head: { sha: "ffff6666", ref: "feature/42-competing" },
        },
      },
      error: null,
    });

    await processPendingGitHubEvents({
      workspaceDir: tempDir,
      eventStore,
      runStore,
    });

    const runs = await runStore.findByPr(101, 202, 14, "ffff6666");
    expect(runs[0]?.issueRuntimeId).toBeNull();

    const projects = await readProjects(tempDir);
    expect(projects.projects.demo?.issueRuntime?.["42"]).toMatchObject({
      currentPrNumber: 13,
      currentPrIssueTarget: 42,
    });
  });
});
