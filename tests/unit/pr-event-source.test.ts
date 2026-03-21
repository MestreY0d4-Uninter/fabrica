import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureFabricaRun, transitionFabricaRun, type PrEventInput } from "../../lib/github/pr-event-source.js";
import { InMemoryFabricaRunStore } from "../../lib/github/event-store.js";

const baseInput: PrEventInput = {
  source: "polling",
  projectSlug: "my-project",
  issueId: 7,
  prNumber: 42,
  headSha: "abc123def456",
  prState: "open",
  deliveryId: "poll-1700000000-7",
  repoIdentity: {
    installationId: 111,
    repositoryId: 999,
    owner: "myorg",
    repo: "myrepo",
    headSha: "abc123def456",
  },
};

describe("ensureFabricaRun", () => {
  it("creates a new FabricaRun when none exists", async () => {
    const store = new InMemoryFabricaRunStore();
    const { run, created } = await ensureFabricaRun(store, baseInput);
    expect(created).toBe(true);
    expect(run.prNumber).toBe(42);
    expect(run.headSha).toBe("abc123def456");
    expect(run.installationId).toBe(111);
    expect(run.state).toBe("planned");
    expect(run.issueRuntimeId).toBe("my-project:7");
  });

  it("returns existing Run without creating duplicate (dedup)", async () => {
    const store = new InMemoryFabricaRunStore();
    const { run: first } = await ensureFabricaRun(store, baseInput);
    const { run: second, created } = await ensureFabricaRun(store, baseInput);
    expect(created).toBe(false);
    expect(second.runId).toBe(first.runId);
  });

  it("creates Run with state 'passed' for merged PR", async () => {
    const store = new InMemoryFabricaRunStore();
    const { run } = await ensureFabricaRun(store, { ...baseInput, prState: "merged" });
    expect(run.state).toBe("passed");
  });

  it("creates Run with state 'aborted' for closed PR", async () => {
    const store = new InMemoryFabricaRunStore();
    const { run } = await ensureFabricaRun(store, { ...baseInput, prState: "closed" });
    expect(run.state).toBe("aborted");
  });

  it("deduplicates even when headSha changes (same prNumber)", async () => {
    const store = new InMemoryFabricaRunStore();
    await ensureFabricaRun(store, baseInput);
    const { run, created } = await ensureFabricaRun(store, {
      ...baseInput,
      headSha: "newsha999",
      repoIdentity: { ...baseInput.repoIdentity, headSha: "newsha999" },
    });
    // findByPr finds the existing run regardless of headSha
    expect(created).toBe(false);
    // headSha of existing run is unchanged
    expect(run.headSha).toBe("abc123def456");
  });
});

describe("transitionFabricaRun", () => {
  it("returns null when nothing changed (same headSha, open PR)", async () => {
    const store = new InMemoryFabricaRunStore();
    const { run } = await ensureFabricaRun(store, baseInput);
    const result = await transitionFabricaRun(store, run, baseInput);
    expect(result).toBeNull();
  });

  it("transitions to 'passed' when PR merged", async () => {
    const store = new InMemoryFabricaRunStore();
    const { run } = await ensureFabricaRun(store, baseInput);
    const updated = await transitionFabricaRun(store, run, { ...baseInput, prState: "merged" });
    expect(updated).not.toBeNull();
    expect(updated?.state).toBe("passed");
  });

  it("transitions to 'aborted' when PR closed", async () => {
    const store = new InMemoryFabricaRunStore();
    const { run } = await ensureFabricaRun(store, baseInput);
    const updated = await transitionFabricaRun(store, run, { ...baseInput, prState: "closed" });
    expect(updated).not.toBeNull();
    expect(updated?.state).toBe("aborted");
  });

  it("updates headSha (PR_SYNCHRONIZED) when headSha differs on open PR", async () => {
    const store = new InMemoryFabricaRunStore();
    const { run } = await ensureFabricaRun(store, baseInput);
    const updated = await transitionFabricaRun(store, run, {
      ...baseInput,
      headSha: "new-sha-999",
      repoIdentity: { ...baseInput.repoIdentity, headSha: "new-sha-999" },
    });
    expect(updated).not.toBeNull();
    expect(updated?.headSha).toBe("new-sha-999");
    expect(updated?.state).toBe("planned");
  });

  it("is a no-op when run already passed (idempotent)", async () => {
    const store = new InMemoryFabricaRunStore();
    const { run } = await ensureFabricaRun(store, { ...baseInput, prState: "merged" });
    expect(run.state).toBe("passed");
    const result = await transitionFabricaRun(store, run, { ...baseInput, prState: "merged" });
    expect(result).toBeNull();
  });
});
