import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestHarness, type TestHarness } from "../../lib/testing/index.js";
import { dispatchTask } from "../../lib/dispatch/index.js";
import { executeCompletion } from "../../lib/services/pipeline.js";
import { projectTick } from "../../lib/services/tick.js";
import { registerSubagentLifecycleHook } from "../../lib/dispatch/subagent-lifecycle-hook.js";
import { setPluginWakeHandler } from "../../lib/services/heartbeat/wake-bridge.js";
import { DATA_DIR } from "../../lib/setup/constants.js";
import { DEFAULT_WORKFLOW, ReviewPolicy, TestPolicy, type WorkflowConfig } from "../../lib/workflow/index.js";
import { resolveEnvironmentContractVersion } from "../../lib/test-env/state.js";

const { mockCreateProvider } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
}));

vi.mock("../../lib/providers/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/providers/index.js")>(
    "../../lib/providers/index.js",
  );
  return {
    ...actual,
    createProvider: mockCreateProvider,
  };
});

function smokeWorkflow(): WorkflowConfig {
  return {
    ...DEFAULT_WORKFLOW,
    reviewPolicy: ReviewPolicy.AGENT,
    testPolicy: TestPolicy.AGENT,
  };
}

describe.sequential("orchestration smoke", () => {
  let h: TestHarness | null = null;
  const wakeReasons: string[] = [];

  afterEach(async () => {
    setPluginWakeHandler(null);
    vi.clearAllMocks();
    if (h) await h.cleanup();
    h = null;
  });

  it("dispatches developer work, advances reviewer via subagent_ended, and picks up tester work", async () => {
    h = await createTestHarness({
      workflow: smokeWorkflow(),
      workers: {
        reviewer: { level: "medior" },
        tester: { level: "medior" },
      },
    });
    const seeded = await h.readProjects();
    seeded.projects[h.project.slug]!.stack = "python-cli";
    seeded.projects[h.project.slug]!.environment = {
      status: "ready",
      stack: "python-cli",
      contractVersion: resolveEnvironmentContractVersion("python-cli"),
      lastProvisionedAt: new Date().toISOString(),
      lastProvisionError: null,
      nextProvisionRetryAt: null,
    };
    await h.writeProjects(seeded);
    await fs.mkdir(path.join(h.workspaceDir, DATA_DIR, "projects", h.project.slug), { recursive: true });
    await fs.writeFile(
      path.join(h.workspaceDir, DATA_DIR, "projects", h.project.slug, "workflow.yaml"),
      "workflow:\n  reviewPolicy: agent\n  testPolicy: agent\n",
      "utf-8",
    );
    wakeReasons.length = 0;
    setPluginWakeHandler(async (reason) => {
      wakeReasons.push(reason);
    });
    mockCreateProvider.mockResolvedValue({ provider: h.provider, type: "github" });

    const workflow = smokeWorkflow();
    const issueId = 101;
    const prNumber = 501;
    const prUrl = `https://example.com/pr/${prNumber}`;

    h.provider.seedIssue({ iid: issueId, title: "Smoke orchestration", labels: ["To Do"] });

    const dispatchResult = await dispatchTask({
      workspaceDir: h.workspaceDir,
      agentId: "smoke-agent",
      project: h.project,
      issueId,
      issueTitle: "Smoke orchestration",
      issueDescription: "Exercise the path from dispatch to tester pickup",
      issueUrl: `https://example.com/issues/${issueId}`,
      role: "developer",
      level: "medior",
      fromLabel: "To Do",
      toLabel: "Doing",
      provider: h.provider,
      runCommand: h.runCommand,
    });

    expect(dispatchResult.sessionAction).toBe("spawn");
    expect((await h.provider.getIssue(issueId)).labels).toContain("Doing");

    const developerCompletion = await executeCompletion({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      channels: h.project.channels,
      role: "developer",
      result: "done",
      issueId,
      summary: "Developer work complete",
      provider: h.provider,
      repoPath: h.project.repo,
      projectName: h.project.name,
      runCommand: h.runCommand,
      workflow,
      level: "medior",
    });

    expect(developerCompletion.labelTransition).toBe("Doing → To Review");
    expect((await h.provider.getIssue(issueId)).labels).toContain("To Review");

    h.provider.setPrStatus(issueId, {
      number: prNumber,
      state: "open",
      url: prUrl,
      currentIssueMatch: true,
    });

    const reviewerPickup = await projectTick({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      agentId: "smoke-agent",
      provider: h.provider,
      runCommand: h.runCommand,
      workflow,
      targetRole: "reviewer",
    });

    expect(reviewerPickup.pickups).toHaveLength(1);
    expect((await h.provider.getIssue(issueId)).labels).toContain("Reviewing");

    const reviewerProjects = await h.readProjects();
    const reviewerLevels = reviewerProjects.projects[h.project.slug]!.workers.reviewer.levels;
    const reviewerSlot = Object.values(reviewerLevels)
      .flat()
      .find((slot) => slot.issueId === String(issueId) || slot.active);
    expect(reviewerSlot?.active).toBe(true);
    expect(reviewerSlot?.sessionKey).toBeTruthy();

    let subagentEndedHandler: ((event: any) => Promise<void>) | undefined;
    registerSubagentLifecycleHook(
      {
        on: vi.fn((hookName: string, handler: (event: any) => Promise<void>) => {
          if (hookName === "subagent_ended") subagentEndedHandler = handler;
        }),
      } as any,
      {
        config: { agents: { defaults: { workspace: h.workspaceDir } } },
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        pluginConfig: {},
        runCommand: h.runCommand,
        runtime: {
          subagent: {
            getSessionMessages: vi.fn(async () => [
              {
                role: "assistant",
                content: [{ type: "text", text: "Review result: APPROVE" }],
              },
            ]),
          },
        },
      } as any,
    );

    expect(subagentEndedHandler).toBeTypeOf("function");

    await subagentEndedHandler!({
      targetSessionKey: reviewerSlot?.sessionKey,
      outcome: "ok",
    });

    expect((await h.provider.getIssue(issueId)).labels).toContain("To Test");
    expect(wakeReasons).toContain("subagent_ended");

    const refreshedProjects = await h.readProjects();
    const refreshedReviewerSlot = Object.values(
      refreshedProjects.projects[h.project.slug]!.workers.reviewer.levels,
    )
      .flat()
      .find((slot) => slot.sessionKey === reviewerSlot?.sessionKey);
    expect(refreshedReviewerSlot?.active).toBe(false);

    const testerPickup = await projectTick({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      agentId: "smoke-agent",
      provider: h.provider,
      runCommand: h.runCommand,
      workflow,
      targetRole: "tester",
    });

    expect(testerPickup.pickups).toHaveLength(1);
    expect((await h.provider.getIssue(issueId)).labels).toContain("Testing");

    const auditLogPath = path.join(h.workspaceDir, DATA_DIR, "log", "audit.log");
    const auditLines = (await fs.readFile(auditLogPath, "utf-8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(auditLines.some((entry) => entry.event === "reviewer_session_transition")).toBe(true);
  }, 60_000);
});
