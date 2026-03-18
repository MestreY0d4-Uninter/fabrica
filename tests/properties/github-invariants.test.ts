import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { InMemoryFabricaRunStore, InMemoryGitHubEventStore } from "../../lib/github/event-store.js";
import { processGitHubEventRecord, processPendingGitHubEvents } from "../../lib/github/process-events.js";
import { readProjects } from "../../lib/projects/io.js";
import { evaluateIssueCloseGuard } from "../../lib/services/pipeline.js";
import { PrState, type PrStatus } from "../../lib/providers/provider.js";

const fcNumRuns = Number(process.env.FAST_CHECK_NUM_RUNS ?? 100);
const propertyConfig = { numRuns: Math.min(Math.max(fcNumRuns, 100), 1000) };

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(tempDirs).map(async (dir) => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    tempDirs.delete(dir);
  }));
});

const hexStringArb = fc
  .array(fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"), {
    minLength: 7,
    maxLength: 12,
  })
  .map((chars) => chars.join(""));

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-props-"));
  tempDirs.add(dir);
  await fs.mkdir(path.join(dir, "fabrica"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "fabrica", "projects.json"),
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
  return dir;
}

function pullRequestEvent(params: {
  deliveryId: string;
  action: string;
  prNumber: number;
  headSha: string;
  issueId?: number;
  merged?: boolean;
}): any {
  const issueId = params.issueId ?? 42;
  return {
    deliveryId: params.deliveryId,
    eventName: "pull_request",
    action: params.action,
    installationId: 101,
    repositoryId: 202,
    prNumber: params.prNumber,
    headSha: params.headSha,
    receivedAt: new Date().toISOString(),
    processedAt: null,
    status: "pending",
    payload: {
      action: params.action,
      installation: { id: 101 },
      repository: { id: 202, name: "demo", owner: { login: "acme" } },
      pull_request: {
        number: params.prNumber,
        title: `feat: issue #${issueId}`,
        body: `Implements #${issueId}`,
        html_url: `https://github.com/acme/demo/pull/${params.prNumber}`,
        state: params.action === "closed" && !params.merged ? "closed" : "open",
        merged: params.merged ?? false,
        merged_at: params.merged ? new Date().toISOString() : null,
        head: { sha: params.headSha, ref: `feature/${issueId}-${params.prNumber}` },
      },
    },
    error: null,
  };
}

function reviewEvent(params: {
  deliveryId: string;
  prNumber: number;
  headSha: string;
  reviewState: "APPROVED" | "CHANGES_REQUESTED";
  issueId?: number;
}): any {
  const issueId = params.issueId ?? 42;
  return {
    deliveryId: params.deliveryId,
    eventName: "pull_request_review",
    action: "submitted",
    installationId: 101,
    repositoryId: 202,
    prNumber: params.prNumber,
    headSha: params.headSha,
    receivedAt: new Date().toISOString(),
    processedAt: null,
    status: "pending",
    payload: {
      action: "submitted",
      installation: { id: 101 },
      repository: { id: 202, name: "demo", owner: { login: "acme" } },
      pull_request: {
        number: params.prNumber,
        title: `feat: issue #${issueId}`,
        body: `Implements #${issueId}`,
        html_url: `https://github.com/acme/demo/pull/${params.prNumber}`,
        head: { sha: params.headSha, ref: `feature/${issueId}-${params.prNumber}` },
      },
      review: { state: params.reviewState },
    },
    error: null,
  };
}

function prStatusFromState(state: "open" | "closed" | "merged", prNumber = 7): PrStatus {
  return {
    number: prNumber,
    state: state === "open" ? PrState.OPEN : state === "merged" ? PrState.MERGED : PrState.CLOSED,
    url: `https://github.com/acme/demo/pull/${prNumber}`,
  };
}

const HEAVY_PROPERTY_TIMEOUT_MS = 60_000;

describe("GitHub invariants", () => {
  it("INVARIANTE 1 — processar o mesmo delivery não duplica efeitos", { timeout: HEAVY_PROPERTY_TIMEOUT_MS }, async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 5 }),
      fc.integer({ min: 1, max: 999 }),
      hexStringArb,
      async (replays, prNumber, rawHeadSha) => {
        const workspaceDir = await makeWorkspace();
        const eventStore = new InMemoryGitHubEventStore();
        const runStore = new InMemoryFabricaRunStore();
        const headSha = rawHeadSha.padEnd(7, "a");
        const record = pullRequestEvent({
          deliveryId: "delivery-fixed",
          action: "opened",
          prNumber,
          headSha,
        });
        await eventStore.saveReceived(record);
        await processPendingGitHubEvents({ workspaceDir, eventStore, runStore });
        for (let i = 0; i < replays; i++) {
          await processGitHubEventRecord({
            workspaceDir,
            record,
            eventStore,
            runStore,
          });
        }

        const runs = await runStore.findByPr(101, 202, prNumber);
        const projects = await readProjects(workspaceDir);
        expect(runs).toHaveLength(1);
        expect(projects.projects.demo?.issueRuntime?.["42"]?.currentPrNumber).toBe(prNumber);
        expect(projects.projects.demo?.issueRuntime?.["42"]?.lastRunId).toBe(runs[0]?.runId);
      },
    ), propertyConfig);
  });

  it("INVARIANTE 2 — um ciclo nunca fecha com PR aberta", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom<"open" | "closed" | "merged">("open", "closed", "merged"),
      fc.boolean(),
      async (prState, hasArtifact) => {
        const result = evaluateIssueCloseGuard({
          prStatus: prStatusFromState(prState),
          issueRuntime: {
            currentPrNumber: 7,
            currentPrUrl: "https://github.com/acme/demo/pull/7",
            currentPrState: prState,
            artifactOfRecord: hasArtifact ? {
              prNumber: 7,
              headSha: "abc123",
              mergedAt: new Date().toISOString(),
              url: "https://github.com/acme/demo/pull/7",
            } : null,
            lastHeadSha: "abc123",
            lastRunId: "run-7",
            lastCheckRunId: 77,
          },
          followUpPrRequired: false,
        });

        if (prState === "open") {
          expect(result.allowed).toBe(false);
          expect(result.reason).toBe("open_pr");
        }
      },
    ), propertyConfig);
  });

  it("INVARIANTE 3 — Done exige artifactOfRecord (exceto quando API confirma merge)", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom<"closed" | "merged">("closed", "merged"),
      fc.boolean(),
      async (prState, followUpPrRequired) => {
        const result = evaluateIssueCloseGuard({
          prStatus: prStatusFromState(prState),
          issueRuntime: {
            currentPrNumber: 7,
            currentPrUrl: "https://github.com/acme/demo/pull/7",
            currentPrState: prState,
            artifactOfRecord: null,
            lastHeadSha: "abc123",
            lastRunId: "run-7",
            lastCheckRunId: 77,
          },
          followUpPrRequired,
        });

        if (prState === "merged") {
          // Live API confirms merge → artifact proven, close allowed (unless follow-up required)
          if (followUpPrRequired) {
            expect(result.allowed).toBe(false);
            expect(result.reason).toBe("follow_up_pr_required");
          } else {
            expect(result.allowed).toBe(true);
          }
        } else {
          // PR closed without merge → artifact missing, block close
          expect(result.allowed).toBe(false);
          expect(result.reason).toBe("missing_artifact_of_record");
        }
      },
    ), propertyConfig);
  });

  it("INVARIANTE 4 — force-push atualiza binding sem duplicar FabricaRun", { timeout: HEAVY_PROPERTY_TIMEOUT_MS }, async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 999 }),
      fc.array(hexStringArb, { minLength: 2, maxLength: 8 }),
      async (prNumber, rawHeadShas) => {
        const workspaceDir = await makeWorkspace();
        const eventStore = new InMemoryGitHubEventStore();
        const runStore = new InMemoryFabricaRunStore();
        const headShas = rawHeadShas.map((value, index) => (value + index.toString(16)).padEnd(7, "b"));

        for (const [index, headSha] of headShas.entries()) {
          await eventStore.saveReceived(pullRequestEvent({
            deliveryId: `delivery-sync-${index}`,
            action: index === 0 ? "opened" : "synchronize",
            prNumber,
            headSha,
          }));
        }

        await processPendingGitHubEvents({ workspaceDir, eventStore, runStore });
        const runs = await runStore.findByPr(101, 202, prNumber);
        expect(runs).toHaveLength(1);
        expect(runs[0]?.headSha).toBe(headShas.at(-1));
      },
    ), propertyConfig);
  });

  it("INVARIANTE 5 — retarget não quebra a issue Fabrica ligada", { timeout: HEAVY_PROPERTY_TIMEOUT_MS }, async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 999 }),
      hexStringArb,
      async (prNumber, rawHeadSha) => {
        const workspaceDir = await makeWorkspace();
        const eventStore = new InMemoryGitHubEventStore();
        const runStore = new InMemoryFabricaRunStore();
        const headSha = rawHeadSha.padEnd(7, "c");

        await eventStore.saveReceived(pullRequestEvent({
          deliveryId: "delivery-open",
          action: "opened",
          prNumber,
          headSha,
        }));
        await eventStore.saveReceived(pullRequestEvent({
          deliveryId: "delivery-edit",
          action: "edited",
          prNumber,
          headSha,
        }));

        await processPendingGitHubEvents({ workspaceDir, eventStore, runStore });
        const projects = await readProjects(workspaceDir);
        expect(projects.projects.demo?.issueRuntime?.["42"]?.currentPrIssueTarget).toBe(42);
      },
    ), propertyConfig);
  });

  it("INVARIANTE 6 — múltiplas PRs para a mesma issue não colidem em estado", { timeout: HEAVY_PROPERTY_TIMEOUT_MS }, async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: 999 }), { minLength: 2, maxLength: 5 }),
      fc.array(fc.boolean(), { minLength: 2, maxLength: 5 }),
      async (prNumbers, mergedFlags) => {
        const workspaceDir = await makeWorkspace();
        const eventStore = new InMemoryGitHubEventStore();
        const runStore = new InMemoryFabricaRunStore();
        const flags = mergedFlags.slice(0, prNumbers.length);
        while (flags.length < prNumbers.length) flags.push(false);

        for (const [index, prNumber] of prNumbers.entries()) {
          const headSha = `sha${prNumber}`.padEnd(7, "d");
          await eventStore.saveReceived(pullRequestEvent({
            deliveryId: `delivery-open-${prNumber}`,
            action: "opened",
            prNumber,
            headSha,
          }));
          if (flags[index]) {
            await eventStore.saveReceived(reviewEvent({
              deliveryId: `delivery-review-${prNumber}`,
              prNumber,
              headSha,
              reviewState: "APPROVED",
            }));
            await eventStore.saveReceived(pullRequestEvent({
              deliveryId: `delivery-close-${prNumber}`,
              action: "closed",
              prNumber,
              headSha,
              merged: true,
            }));
          }
        }

        await processPendingGitHubEvents({ workspaceDir, eventStore, runStore });

        const allRuns = await Promise.all(prNumbers.map((prNumber) => runStore.findByPr(101, 202, prNumber)));
        for (const runs of allRuns) {
          expect(runs).toHaveLength(1);
        }

        const mergedCount = flags.filter(Boolean).length;
        const terminalStates = allRuns.map((runs) => runs[0]?.state);
        if (mergedCount !== prNumbers.length) {
          expect(terminalStates.some((state) => state === "running")).toBe(true);
        } else {
          expect(terminalStates.every((state) => state === "passed")).toBe(true);
        }
      },
    ), {
      ...propertyConfig,
      numRuns: Math.max(100, Math.min(150, propertyConfig.numRuns)),
    });
  });
});
