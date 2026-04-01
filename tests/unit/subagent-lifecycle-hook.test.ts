import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerSubagentLifecycleHook } from "../../lib/dispatch/subagent-lifecycle-hook.js";
import { DEFAULT_WORKFLOW } from "../../lib/workflow/index.js";
import { resolveReviewerDecisionTransition } from "../../lib/services/reviewer-completion.js";

// Hoist mocks before any imports are resolved
const {
  mockAuditLog,
  mockReadProjects,
  mockDeactivateWorker,
  mockLoadConfig,
  mockCreateProvider,
  mockHandleReviewerAgentEnd,
} = vi.hoisted(() => ({
  mockAuditLog: vi.fn(),
  mockReadProjects: vi.fn(),
  mockDeactivateWorker: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockCreateProvider: vi.fn(),
  mockHandleReviewerAgentEnd: vi.fn(),
}));

vi.mock("../../lib/audit.js", () => ({
  log: mockAuditLog,
}));

vi.mock("../../lib/projects/index.js", () => ({
  readProjects: mockReadProjects,
  deactivateWorker: mockDeactivateWorker,
}));

vi.mock("../../lib/config/index.js", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("../../lib/providers/index.js", () => ({
  createProvider: mockCreateProvider,
}));

vi.mock("../../lib/services/reviewer-completion.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/services/reviewer-completion.js")>("../../lib/services/reviewer-completion.js");
  return {
    ...actual,
    handleReviewerAgentEnd: mockHandleReviewerAgentEnd,
  };
});

const workspaceDir = "/tmp/test-workspace";

function makeApi() {
  let handler: ((event: any, ctx: any) => Promise<void>) | undefined;
  const api = {
    on: vi.fn((hookName: string, h: any) => {
      if (hookName === "subagent_ended") handler = h;
    }),
  } as unknown as OpenClawPluginApi;
  return { api, getHandler: () => handler };
}

function makeCtx(ws?: string) {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    config: ws
      ? { agents: { defaults: { workspace: ws } } }
      : {},
    pluginConfig: {},
  } as any;
}

describe("subagent_ended hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProjects.mockResolvedValue({
      projects: {
        demo: {
          name: "my-project",
          slug: "demo",
          repo: "org/repo",
          provider: "github",
          workers: {
            developer: {
              levels: {
                medior: [
                  {
                    active: true,
                    issueId: "42",
                    lastIssueId: null,
                    sessionKey: "agent:fabrica:subagent:my-project-developer-medior-ada",
                    dispatchCycleId: "cycle-1",
                    dispatchRunId: "run-1",
                  },
                ],
              },
            },
            reviewer: {
              levels: {
                senior: [
                  {
                    active: true,
                    issueId: "43",
                    lastIssueId: null,
                    sessionKey: "agent:main:subagent:acme-reviewer-senior-bob",
                    dispatchCycleId: "cycle-2",
                    dispatchRunId: "run-2",
                  },
                ],
              },
            },
          },
          issueRuntime: {
            "42": {
              lastDispatchCycleId: "cycle-1",
              dispatchRunId: "run-1",
            },
            "43": {
              lastDispatchCycleId: "cycle-2",
              dispatchRunId: "run-2",
            },
          },
        },
      },
    });
    mockLoadConfig.mockResolvedValue({ workflow: DEFAULT_WORKFLOW });
    mockCreateProvider.mockResolvedValue({
      provider: {
        getIssue: vi.fn().mockResolvedValue({ labels: ["Doing"] }),
        transitionLabel: vi.fn().mockResolvedValue(undefined),
      },
    });
    mockHandleReviewerAgentEnd.mockResolvedValue(null);
  });

  it("registers a subagent_ended hook via api.on when workspace is configured", () => {
    const { api } = makeApi();
    registerSubagentLifecycleHook(api, makeCtx(workspaceDir));
    expect(api.on).toHaveBeenCalledWith("subagent_ended", expect.any(Function));
  });

  it("does not register hook when workspaceDir cannot be resolved", () => {
    const { api } = makeApi();
    registerSubagentLifecycleHook(api, makeCtx(undefined));
    expect(api.on).not.toHaveBeenCalled();
  });

  it("triggers audit log when worker subagent ends", async () => {
    const { api, getHandler } = makeApi();
    registerSubagentLifecycleHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    mockAuditLog.mockResolvedValue(undefined);

    await handler(
      {
        targetSessionKey: "agent:fabrica:subagent:my-project-developer-medior-ada",
        targetKind: "worker",
        reason: "completed",
        outcome: "ok",
      },
      {},
    );

    expect(mockAuditLog).toHaveBeenCalledWith(
      workspaceDir,
      "subagent_ended",
      expect.objectContaining({
        sessionKey: "agent:fabrica:subagent:my-project-developer-medior-ada",
        project: "my-project",
        role: "developer",
        outcome: "ok",
      }),
    );
  });

  it("does nothing for non-worker session keys", async () => {
    const { api, getHandler } = makeApi();
    registerSubagentLifecycleHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    mockAuditLog.mockResolvedValue(undefined);

    // Session key that doesn't match the Fabrica worker pattern
    await handler(
      {
        targetSessionKey: "agent:fabrica:orchestrator",
        targetKind: "orchestrator",
        reason: "completed",
        outcome: "ok",
      },
      {},
    );

    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("handles missing sessionKey gracefully", async () => {
    const { api, getHandler } = makeApi();
    registerSubagentLifecycleHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    mockAuditLog.mockResolvedValue(undefined);

    // No targetSessionKey — should not crash
    await expect(
      handler(
        {
          targetSessionKey: undefined,
          targetKind: "worker",
          reason: "completed",
          outcome: "ok",
        },
        {},
      ),
    ).resolves.toBeUndefined();

    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("logs outcome as 'unknown' when outcome is not provided", async () => {
    const { api, getHandler } = makeApi();
    registerSubagentLifecycleHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    mockAuditLog.mockResolvedValue(undefined);

    await handler(
      {
        targetSessionKey: "agent:main:subagent:acme-reviewer-senior-bob",
        targetKind: "worker",
        reason: "killed",
      },
      {},
    );

    expect(mockAuditLog).toHaveBeenCalledWith(
      workspaceDir,
      "subagent_ended",
      expect.objectContaining({
        project: "acme",
        role: "reviewer",
        outcome: "unknown",
      }),
    );
  });

  it("does not throw even if auditLog rejects", async () => {
    const { api, getHandler } = makeApi();
    registerSubagentLifecycleHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    mockAuditLog.mockRejectedValue(new Error("disk full"));

    await expect(
      handler(
        {
          targetSessionKey: "agent:fabrica:subagent:my-project-developer-medior-ada",
          targetKind: "worker",
          reason: "completed",
          outcome: "ok",
        },
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it("handles numeric slot session keys (legacy named format)", async () => {
    const { api, getHandler } = makeApi();
    registerSubagentLifecycleHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    mockAuditLog.mockResolvedValue(undefined);

    await handler(
      {
        targetSessionKey: "agent:fabrica:subagent:my-project-developer-medior-0",
        targetKind: "worker",
        reason: "completed",
        outcome: "ok",
      },
      {},
    );

    expect(mockAuditLog).toHaveBeenCalledWith(
      workspaceDir,
      "subagent_ended",
      expect.objectContaining({
        project: "my-project",
        role: "developer",
      }),
    );
  });

  it("uses reviewing-state reviewer transitions instead of toReview review events", () => {
    const approve = resolveReviewerDecisionTransition(DEFAULT_WORKFLOW, "approve");
    const reject = resolveReviewerDecisionTransition(DEFAULT_WORKFLOW, "reject");

    expect(approve?.eventKey).toBe("APPROVE");
    expect(approve?.targetLabel).toBe("To Test");
    expect(reject?.eventKey).toBe("REJECT");
    expect(reject?.targetLabel).toBe("To Improve");
  });

  it("treats non-reviewer subagent_ended as repair-only when completion was already applied", async () => {
    const { api, getHandler } = makeApi();
    registerSubagentLifecycleHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    mockReadProjects.mockResolvedValueOnce({
      projects: {
        demo: {
          name: "my-project",
          slug: "demo",
          repo: "org/repo",
          provider: "github",
          workers: {
            developer: {
              levels: {
                medior: [
                  {
                    active: false,
                    issueId: null,
                    lastIssueId: "42",
                    sessionKey: "agent:fabrica:subagent:my-project-developer-medior-ada",
                    dispatchCycleId: "cycle-1",
                    dispatchRunId: "run-1",
                  },
                ],
              },
            },
          },
          issueRuntime: {
            "42": {
              lastDispatchCycleId: "cycle-1",
              dispatchRunId: "run-1",
              sessionCompletedAt: "2026-04-01T12:00:00.000Z",
            },
          },
        },
      },
    });

    await handler(
      {
        targetSessionKey: "agent:fabrica:subagent:my-project-developer-medior-ada",
        targetKind: "worker",
        reason: "completed",
        outcome: "ok",
        runId: "run-1",
      },
      {},
    );

    expect(mockAuditLog).toHaveBeenCalledWith(
      workspaceDir,
      "worker_lifecycle_repair_observed",
      expect.objectContaining({
        sessionKey: "agent:fabrica:subagent:my-project-developer-medior-ada",
        role: "developer",
        issueId: "42",
      }),
    );
    expect(mockDeactivateWorker).not.toHaveBeenCalled();
    expect(mockCreateProvider).not.toHaveBeenCalled();
  });
});
