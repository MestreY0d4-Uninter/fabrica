import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../../lib/testing/harness.js";
import { writeProjects } from "../../lib/projects/index.js";
import { DEFAULT_WORKFLOW, ReviewPolicy } from "../../lib/workflow/index.js";

const { mockAuditLog, mockWakeHeartbeat } = vi.hoisted(() => ({
  mockAuditLog: vi.fn(),
  mockWakeHeartbeat: vi.fn(),
}));

vi.mock("../../lib/audit.js", () => ({
  log: mockAuditLog,
}));

vi.mock("../../lib/services/heartbeat/wake-bridge.js", () => ({
  wakeHeartbeat: mockWakeHeartbeat,
  setPluginWakeHandler: vi.fn(),
  hasWakeHandler: vi.fn(),
  getSpawnTime: vi.fn(),
  clearSpawnTime: vi.fn(),
}));

async function makeCycleAwareWorkFinishTool(h: Awaited<ReturnType<typeof createTestHarness>>) {
  const helpers = await import("../../lib/tools/helpers.js");
  const pipeline = await import("../../lib/services/pipeline.js");
  const config = await import("../../lib/config/index.js");
  const labels = await import("../../lib/workflow/labels.js");
  const notify = await import("../../lib/dispatch/notify.js");
  const projects = await import("../../lib/projects/index.js");

  vi.spyOn(helpers, "resolveProvider").mockResolvedValue({ provider: h.provider, type: "github" } as any);
  vi.spyOn(pipeline, "executeCompletion").mockResolvedValue({ labelTransition: "Doing -> To Test" } as any);
  vi.spyOn(pipeline, "getRule").mockReturnValue({ to: "To Test" } as any);
  vi.spyOn(config, "loadConfig").mockResolvedValue({
    workflow: h.workflow,
    workflowMeta: { sourceLayers: [], hash: "test", normalizationFixes: [], keyTransitions: [] },
    timeouts: { sessionPatchMs: 5_000, dispatchMs: 30_000, sessionContextBudget: 1 },
    roles: { developer: { completionResults: ["done"] } },
  } as any);
  vi.spyOn(labels, "resilientLabelTransition").mockResolvedValue({ success: true, dualStateResolved: false } as any);
  vi.spyOn(notify, "notify").mockResolvedValue(undefined as any);
  vi.spyOn(notify, "getNotificationConfig").mockReturnValue({} as any);

  const firstWorkerActivity = vi.spyOn(projects, "recordIssueLifecycleBySessionKey").mockResolvedValue(false as any);
  const lifecycle = vi.spyOn(projects, "recordIssueLifecycle").mockResolvedValue(false as any);
  const updateIssueRuntime = vi.spyOn(projects, "updateIssueRuntime").mockResolvedValue({} as any);
  const deactivateWorker = vi.spyOn(projects, "deactivateWorker").mockResolvedValue({} as any);

  const { createWorkFinishTool } = await import("../../lib/tools/worker/work-finish.js");
  const tool = createWorkFinishTool({
    pluginConfig: {},
    runtime: undefined,
    observability: {
      withContext: async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
      withSpan: async (_name: string, _ctx: unknown, fn: () => Promise<unknown>) => fn(),
      logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any),
    },
    runCommand: h.runCommand,
  } as any)({
    workspaceDir: h.workspaceDir,
    sessionKey: "agent:test:subagent:identity-proj-developer-senior-ada",
  } as any);

  return {
    tool,
    firstWorkerActivity,
    lifecycle,
    updateIssueRuntime,
    deactivateWorker,
  };
}

async function captureReactiveDispatchHandlers() {
  const { registerReactiveDispatchHooks } = await import("../../lib/dispatch/reactive-dispatch-hook.js");
  const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
  const api = {
    on: vi.fn((name: string, handler: (event: any, ctx: any) => Promise<any>) => {
      handlers[name] = handler;
    }),
  };
  registerReactiveDispatchHooks(api as any, {
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: {
      system: { requestHeartbeatNow: vi.fn() },
    },
  } as any);
  return handlers;
}

describe("dispatch identity hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockAuditLog.mockResolvedValue(undefined);
    mockWakeHeartbeat.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delayed work_finish with an old cycle proof does not complete a reused slot", async () => {
    const h = await createTestHarness({
      projectName: "identity-proj",
      workflow: { ...DEFAULT_WORKFLOW, reviewPolicy: ReviewPolicy.AGENT },
    });
    try {
      h.provider.seedIssue({
        iid: 42,
        title: "Identity check",
        labels: ["Doing"],
      });
      h.provider.setPrStatus(42, {
        state: "open",
        url: "https://example.com/pr/42",
        body: "## QA Evidence\n\n```bash\nscripts/qa.sh\n```\n\nExit code: 0\n",
        currentIssueMatch: true,
      });

      const data = await h.readProjects();
      data.projects[h.project.slug]!.workers.developer = {
        levels: {
          senior: [
            {
              active: true,
              issueId: "42",
              sessionKey: "agent:test:subagent:identity-proj-developer-senior-ada",
              startTime: new Date().toISOString(),
              previousLabel: "To Do",
              dispatchCycleId: "cycle-new",
              dispatchRunId: "cycle-new",
            } as any,
          ],
        },
      } as any;
      data.projects[h.project.slug]!.issueRuntime = {
        "42": {
          dispatchRequestedAt: new Date().toISOString(),
          lastDispatchCycleId: "cycle-new",
          dispatchRunId: "cycle-new",
        } as any,
      };
      await writeProjects(h.workspaceDir, data);

      const handlers = await captureReactiveDispatchHandlers();
      const injected = await handlers.before_tool_call!(
        {
          toolName: "work_finish",
          params: {
            channelId: h.project.slug,
            role: "developer",
            result: "done",
            summary: "done",
          },
          runId: "cycle-old",
        },
        { runId: "cycle-old", sessionKey: "agent:test:subagent:identity-proj-developer-senior-ada" },
      );

      expect(injected?.params?._dispatchRunId).toBe("cycle-old");

      const { tool, firstWorkerActivity, lifecycle, updateIssueRuntime, deactivateWorker } = await makeCycleAwareWorkFinishTool(h);
      await tool.execute("call-1", injected!.params);

      expect(firstWorkerActivity).not.toHaveBeenCalled();
      expect(lifecycle).not.toHaveBeenCalled();
      expect(updateIssueRuntime).not.toHaveBeenCalled();
      expect(deactivateWorker).not.toHaveBeenCalled();
      expect(h.provider.callsTo("transitionLabel")).toHaveLength(0);
      expect(mockAuditLog).toHaveBeenCalledWith(
        h.workspaceDir,
        "work_finish_rejected",
        expect.objectContaining({ reason: "stale_dispatch_cycle" }),
      );
    } finally {
      await h.cleanup();
    }
  }, 45_000);

  it("delayed subagent_ended against a reused slot does not clean the new cycle", async () => {
    const h = await createTestHarness({
      projectName: "identity-proj",
      workflow: { ...DEFAULT_WORKFLOW, reviewPolicy: ReviewPolicy.AGENT },
    });
    try {
      h.provider.seedIssue({
        iid: 43,
        title: "Subagent cleanup",
        labels: ["Reviewing", "review:agent"],
      });

      const data = await h.readProjects();
      data.projects[h.project.slug]!.workers.reviewer = {
        levels: {
          junior: [
            {
              active: true,
              issueId: "43",
              sessionKey: "agent:test:subagent:identity-proj-reviewer-junior-0",
              startTime: new Date().toISOString(),
              previousLabel: "To Review",
              dispatchCycleId: "cycle-new",
              dispatchRunId: "cycle-new",
            } as any,
          ],
        },
      } as any;
      data.projects[h.project.slug]!.issueRuntime = {
        "43": {
          lastDispatchCycleId: "cycle-new",
          dispatchRunId: "cycle-new",
        } as any,
      };
      await writeProjects(h.workspaceDir, data);

      const { registerSubagentLifecycleHook } = await import("../../lib/dispatch/subagent-lifecycle-hook.js");
      let endedHandler: ((event: any) => Promise<void>) | undefined;
      registerSubagentLifecycleHook({
        on: vi.fn((name: string, handler: (event: any) => Promise<void>) => {
          if (name === "subagent_ended") endedHandler = handler;
        }),
      } as any, {
        config: { agents: { defaults: { workspace: h.workspaceDir } } },
        pluginConfig: {},
        runtime: undefined,
        runCommand: h.runCommand,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as any);

      await endedHandler!({
        targetSessionKey: "agent:test:subagent:identity-proj-reviewer-junior-0",
        runId: "cycle-old",
        outcome: "ok",
        reason: "completed",
      });

      const after = await h.readProjects();
      const slot = after.projects[h.project.slug]!.workers.reviewer.levels.junior[0]!;
      expect(slot.active).toBe(true);
      expect(slot.dispatchCycleId).toBe("cycle-new");
      expect((await h.provider.getIssue(43)).labels).toContain("Reviewing");
      expect(h.provider.callsTo("transitionLabel")).toHaveLength(0);
      expect(mockAuditLog).toHaveBeenCalledWith(
        h.workspaceDir,
        "subagent_ended_slot_cleanup_rejected",
        expect.objectContaining({ reason: "stale_dispatch_cycle" }),
      );
    } finally {
      await h.cleanup();
    }
  });

  it("health recovery refuses stale-cycle cleanup", async () => {
    const h = await createTestHarness({
      projectName: "identity-proj",
      workflow: { ...DEFAULT_WORKFLOW, reviewPolicy: ReviewPolicy.AGENT },
      workers: {
        developer: {
          active: true,
          issueId: "44",
          sessionKey: "agent:test:subagent:identity-proj-developer-senior-ada",
          level: "senior",
          startTime: new Date(Date.now() - 10 * 60_000).toISOString(),
          previousLabel: "To Do",
        },
      },
    });
    try {
      h.provider.seedIssue({
        iid: 44,
        title: "Health stale cleanup",
        labels: ["Doing"],
      });

      const data = await h.readProjects();
      data.projects[h.project.slug]!.workers.developer.levels.senior[0] = {
        active: true,
        issueId: "44",
        sessionKey: "agent:test:subagent:identity-proj-developer-senior-ada",
        startTime: new Date(Date.now() - 10 * 60_000).toISOString(),
        previousLabel: "To Do",
        dispatchCycleId: "cycle-new",
      } as any;
      data.projects[h.project.slug]!.issueRuntime = {
        "44": {
          dispatchRequestedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
          lastDispatchCycleId: "cycle-old",
        } as any,
      };
      await writeProjects(h.workspaceDir, data);

      const { checkWorkerHealth } = await import("../../lib/services/heartbeat/health.js");
      const fixes = await checkWorkerHealth({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        project: data.projects[h.project.slug]!,
        role: "developer",
        autoFix: true,
        provider: h.provider,
        sessions: new Map(),
        staleWorkerHours: 999,
      });

      expect(fixes).toHaveLength(0);
      expect(h.provider.callsTo("transitionLabel")).toHaveLength(0);
      const after = await h.readProjects();
      const slot = after.projects[h.project.slug]!.workers.developer.levels.senior[0]!;
      expect(slot.active).toBe(true);
      expect(slot.dispatchCycleId).toBe("cycle-new");
      expect(mockAuditLog).toHaveBeenCalledWith(
        h.workspaceDir,
        "health_fix_rejected",
        expect.objectContaining({ reason: "stale_dispatch_cycle" }),
      );
    } finally {
      await h.cleanup();
    }
  });
});
