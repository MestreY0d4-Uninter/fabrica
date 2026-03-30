import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestHarness } from "../../lib/testing/harness.js";
import { writeProjects, readProjects } from "../../lib/projects/index.js";
import { DEFAULT_WORKFLOW, ReviewPolicy } from "../../lib/workflow/index.js";

// ---------------------------------------------------------------------------
// Hoist mocks — must be declared before any module import resolution
// ---------------------------------------------------------------------------
const { mockCreateProvider, mockLoadConfig, mockWakeHeartbeat } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockWakeHeartbeat: vi.fn(),
}));

vi.mock("../../lib/providers/index.js", () => ({
  createProvider: mockCreateProvider,
}));

vi.mock("../../lib/config/index.js", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("../../lib/services/heartbeat/wake-bridge.js", () => ({
  wakeHeartbeat: mockWakeHeartbeat,
  setPluginWakeHandler: vi.fn(),
  hasWakeHandler: vi.fn(),
  getSpawnTime: vi.fn(),
  clearSpawnTime: vi.fn(),
}));

// Mock audit log — the hook imports it
const { mockAuditLog } = vi.hoisted(() => ({
  mockAuditLog: vi.fn(),
}));

vi.mock("../../lib/audit.js", () => ({
  log: mockAuditLog,
}));

// Mock spawn time functions from reactive-dispatch-hook
vi.mock("../../lib/dispatch/reactive-dispatch-hook.js", () => ({
  getSpawnTime: vi.fn(() => undefined),
  clearSpawnTime: vi.fn(),
}));

describe("subagent_ended slot cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditLog.mockResolvedValue(undefined);
    mockWakeHeartbeat.mockResolvedValue(undefined);
  });

  it("deactivates slot and reverts label on outcome=ok", async () => {
    const h = await createTestHarness({
      workflow: { ...DEFAULT_WORKFLOW, reviewPolicy: ReviewPolicy.AGENT },
    });
    try {
      h.provider.seedIssue({ iid: 10, title: "Test issue", labels: ["Reviewing", "review:agent"] });

      const data = await h.readProjects();
      const proj = data.projects[h.project.slug]!;
      proj.workers.reviewer = {
        levels: {
          junior: [{
            active: true,
            issueId: "10",
            sessionKey: `agent:test:subagent:${h.project.name}-reviewer-junior-0`,
            startTime: new Date().toISOString(),
            previousLabel: "To Review",
          }],
        },
      };
      await writeProjects(h.workspaceDir, data);

      // Wire mocks so the hook uses the test provider
      mockCreateProvider.mockResolvedValue({ provider: h.provider, type: "github" });
      mockLoadConfig.mockResolvedValue({ workflow: h.workflow });

      const { registerSubagentLifecycleHook } = await import(
        "../../lib/dispatch/subagent-lifecycle-hook.js"
      );

      let endedHandler: ((event: any) => Promise<void>) | null = null;
      const mockApi = {
        on: vi.fn((event: string, handler: any) => {
          if (event === "subagent_ended") endedHandler = handler;
        }),
      };

      registerSubagentLifecycleHook(mockApi as any, {
        config: { agents: { defaults: { workspace: h.workspaceDir } } },
        pluginConfig: {},
        runtime: undefined,
        runCommand: h.runCommand,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as any);

      await endedHandler!({
        targetSessionKey: `agent:test:subagent:${h.project.name}-reviewer-junior-0`,
        outcome: "ok",
        reason: "subagent-complete",
      });

      const after = await readProjects(h.workspaceDir);
      const slot = after.projects[h.project.slug]!.workers.reviewer?.levels.junior?.[0];
      expect(slot?.active).toBe(false);

      const issue = await h.provider.getIssue(10);
      expect(issue.labels).toContain("To Review");
      expect(issue.labels).not.toContain("Reviewing");
    } finally {
      await h.cleanup();
    }
  });

  it("no-op when slot already deactivated by work_finish", async () => {
    const h = await createTestHarness({
      workflow: { ...DEFAULT_WORKFLOW, reviewPolicy: ReviewPolicy.AGENT },
    });
    try {
      h.provider.seedIssue({ iid: 11, title: "Already done", labels: ["To Test"] });

      const data = await h.readProjects();
      const proj = data.projects[h.project.slug]!;
      proj.workers.reviewer = {
        levels: {
          junior: [{
            active: false,
            issueId: null,
            sessionKey: `agent:test:subagent:${h.project.name}-reviewer-junior-0`,
            startTime: null,
            lastIssueId: "11",
          }],
        },
      };
      await writeProjects(h.workspaceDir, data);

      mockCreateProvider.mockResolvedValue({ provider: h.provider, type: "github" });
      mockLoadConfig.mockResolvedValue({ workflow: h.workflow });

      const { registerSubagentLifecycleHook } = await import(
        "../../lib/dispatch/subagent-lifecycle-hook.js"
      );

      let endedHandler: ((event: any) => Promise<void>) | null = null;
      const mockApi = {
        on: vi.fn((event: string, handler: any) => {
          if (event === "subagent_ended") endedHandler = handler;
        }),
      };

      registerSubagentLifecycleHook(mockApi as any, {
        config: { agents: { defaults: { workspace: h.workspaceDir } } },
        pluginConfig: {},
        runtime: undefined,
        runCommand: h.runCommand,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as any);

      await endedHandler!({
        targetSessionKey: `agent:test:subagent:${h.project.name}-reviewer-junior-0`,
        outcome: "ok",
        reason: "subagent-complete",
      });

      const after = await readProjects(h.workspaceDir);
      const slot = after.projects[h.project.slug]!.workers.reviewer?.levels.junior?.[0];
      expect(slot?.active).toBe(false);

      const issue = await h.provider.getIssue(11);
      expect(issue.labels).toContain("To Test");
    } finally {
      await h.cleanup();
    }
  });

  it("deactivates slot on outcome=error", async () => {
    const h = await createTestHarness({
      workflow: { ...DEFAULT_WORKFLOW, reviewPolicy: ReviewPolicy.AGENT },
    });
    try {
      h.provider.seedIssue({ iid: 12, title: "Error case", labels: ["Reviewing", "review:agent"] });

      const data = await h.readProjects();
      const proj = data.projects[h.project.slug]!;
      proj.workers.reviewer = {
        levels: {
          junior: [{
            active: true,
            issueId: "12",
            sessionKey: `agent:test:subagent:${h.project.name}-reviewer-junior-0`,
            startTime: new Date().toISOString(),
            previousLabel: "To Review",
          }],
        },
      };
      await writeProjects(h.workspaceDir, data);

      mockCreateProvider.mockResolvedValue({ provider: h.provider, type: "github" });
      mockLoadConfig.mockResolvedValue({ workflow: h.workflow });

      const { registerSubagentLifecycleHook } = await import(
        "../../lib/dispatch/subagent-lifecycle-hook.js"
      );

      let endedHandler: ((event: any) => Promise<void>) | null = null;
      const mockApi = {
        on: vi.fn((event: string, handler: any) => {
          if (event === "subagent_ended") endedHandler = handler;
        }),
      };

      registerSubagentLifecycleHook(mockApi as any, {
        config: { agents: { defaults: { workspace: h.workspaceDir } } },
        pluginConfig: {},
        runtime: undefined,
        runCommand: h.runCommand,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as any);

      await endedHandler!({
        targetSessionKey: `agent:test:subagent:${h.project.name}-reviewer-junior-0`,
        outcome: "error",
        reason: "subagent-error",
      });

      const after = await readProjects(h.workspaceDir);
      const slot = after.projects[h.project.slug]!.workers.reviewer?.levels.junior?.[0];
      expect(slot?.active).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it("ignores non-Fabrica session keys", async () => {
    const h = await createTestHarness();
    try {
      const { registerSubagentLifecycleHook } = await import(
        "../../lib/dispatch/subagent-lifecycle-hook.js"
      );

      let endedHandler: ((event: any) => Promise<void>) | null = null;
      const mockApi = {
        on: vi.fn((event: string, handler: any) => {
          if (event === "subagent_ended") endedHandler = handler;
        }),
      };

      registerSubagentLifecycleHook(mockApi as any, {
        config: { agents: { defaults: { workspace: h.workspaceDir } } },
        pluginConfig: {},
        runtime: undefined,
        runCommand: h.runCommand,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as any);

      await endedHandler!({
        targetSessionKey: "agent:test:subagent:some-random-session",
        outcome: "ok",
        reason: "subagent-complete",
      });
      // No crash = success
    } finally {
      await h.cleanup();
    }
  });

  it("skips label revert when label already transitioned by work_finish", async () => {
    const h = await createTestHarness({
      workflow: { ...DEFAULT_WORKFLOW, reviewPolicy: ReviewPolicy.AGENT },
    });
    try {
      // Issue already at "To Test" — work_finish already transitioned it
      h.provider.seedIssue({ iid: 13, title: "Already transitioned", labels: ["To Test"] });

      const data = await h.readProjects();
      const proj = data.projects[h.project.slug]!;
      proj.workers.reviewer = {
        levels: {
          junior: [{
            active: true,
            issueId: "13",
            sessionKey: `agent:test:subagent:${h.project.name}-reviewer-junior-0`,
            startTime: new Date().toISOString(),
            previousLabel: "To Review",
          }],
        },
      };
      await writeProjects(h.workspaceDir, data);

      mockCreateProvider.mockResolvedValue({ provider: h.provider, type: "github" });
      mockLoadConfig.mockResolvedValue({ workflow: h.workflow });

      const { registerSubagentLifecycleHook } = await import(
        "../../lib/dispatch/subagent-lifecycle-hook.js"
      );

      let endedHandler: ((event: any) => Promise<void>) | null = null;
      const mockApi = {
        on: vi.fn((event: string, handler: any) => {
          if (event === "subagent_ended") endedHandler = handler;
        }),
      };

      registerSubagentLifecycleHook(mockApi as any, {
        config: { agents: { defaults: { workspace: h.workspaceDir } } },
        pluginConfig: {},
        runtime: undefined,
        runCommand: h.runCommand,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as any);

      await endedHandler!({
        targetSessionKey: `agent:test:subagent:${h.project.name}-reviewer-junior-0`,
        outcome: "ok",
        reason: "subagent-complete",
      });

      const after = await readProjects(h.workspaceDir);
      const slot = after.projects[h.project.slug]!.workers.reviewer?.levels.junior?.[0];
      expect(slot?.active).toBe(false);

      // Label should still be "To Test" — not reverted to "To Review"
      const issue = await h.provider.getIssue(13);
      expect(issue.labels).toContain("To Test");
      expect(issue.labels).not.toContain("To Review");
    } finally {
      await h.cleanup();
    }
  });
});
