import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerSubagentLifecycleHook } from "../../lib/dispatch/subagent-lifecycle-hook.js";

// Hoist mocks before any imports are resolved
const { mockAuditLog } = vi.hoisted(() => ({
  mockAuditLog: vi.fn(),
}));

vi.mock("../../lib/audit.js", () => ({
  log: mockAuditLog,
}));

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
});
