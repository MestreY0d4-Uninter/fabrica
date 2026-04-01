import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerGatewayLifecycleHook } from "../../lib/setup/gateway-lifecycle-hook.js";

// Hoist mocks before any imports are resolved
const { mockAccess, mockReadFile, mockAuditLog, mockRecoverDueBootstraps } = vi.hoisted(() => ({
  mockAccess: vi.fn(),
  mockReadFile: vi.fn(),
  mockAuditLog: vi.fn(),
  mockRecoverDueBootstraps: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    access: mockAccess,
    readFile: mockReadFile,
  },
  access: mockAccess,
  readFile: mockReadFile,
}));

vi.mock("../../lib/audit.js", () => ({
  log: mockAuditLog,
}));

vi.mock("../../lib/dispatch/telegram-bootstrap-hook.js", () => ({
  recoverDueTelegramBootstrapSessions: mockRecoverDueBootstraps,
}));

const workspaceDir = "/tmp/test-workspace";

function makeApi() {
  let handler: ((event: any, ctx: any) => Promise<void>) | undefined;
  const api = {
    on: vi.fn((hookName: string, h: any) => {
      if (hookName === "gateway_start") handler = h;
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

describe("gateway_start hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecoverDueBootstraps.mockResolvedValue(0);
  });

  it("registers a gateway_start hook via api.on when workspace is configured", () => {
    const { api } = makeApi();
    registerGatewayLifecycleHook(api, makeCtx(workspaceDir));
    expect(api.on).toHaveBeenCalledWith("gateway_start", expect.any(Function));
  });

  it("does not register hook when workspaceDir cannot be resolved", () => {
    const { api } = makeApi();
    registerGatewayLifecycleHook(api, makeCtx(undefined));
    expect(api.on).not.toHaveBeenCalled();
  });

  it("logs startup and validates projects.json when workspace exists", async () => {
    const { api, getHandler } = makeApi();
    registerGatewayLifecycleHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(JSON.stringify({ projects: [] }));
    mockAuditLog.mockResolvedValue(undefined);

    await handler({ port: 18789 }, { port: 18789 });

    expect(mockAccess).toHaveBeenCalled();
    expect(mockReadFile).toHaveBeenCalled();
    expect(mockRecoverDueBootstraps).toHaveBeenCalledWith(expect.anything(), workspaceDir);
    expect(mockAuditLog).toHaveBeenCalledWith(
      workspaceDir,
      "gateway_start",
      expect.objectContaining({
        port: 18789,
        bootTime: expect.any(String),
      }),
    );
  });

  it("audits recovered Telegram bootstrap sessions on gateway start", async () => {
    const { api, getHandler } = makeApi();
    registerGatewayLifecycleHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(JSON.stringify({ projects: [] }));
    mockAuditLog.mockResolvedValue(undefined);
    mockRecoverDueBootstraps.mockResolvedValue(2);

    await handler({ port: 18789 }, { port: 18789 });

    expect(mockAuditLog).toHaveBeenCalledWith(
      workspaceDir,
      "gateway_start_bootstrap_recovery",
      expect.objectContaining({ recoveredCount: 2 }),
    );
  });

  it("logs a warning and returns early when workspace data directory is missing", async () => {
    const { api, getHandler } = makeApi();
    registerGatewayLifecycleHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    mockAccess.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    mockAuditLog.mockResolvedValue(undefined);

    await handler({ port: 18789 }, { port: 18789 });

    expect(mockAuditLog).toHaveBeenCalledWith(
      workspaceDir,
      "gateway_start_warning",
      expect.objectContaining({ message: expect.stringContaining("missing") }),
    );
    // Should not proceed to read projects.json
    expect(mockReadFile).not.toHaveBeenCalled();
    // Should not log a normal gateway_start boot event
    expect(mockAuditLog).not.toHaveBeenCalledWith(
      workspaceDir,
      "gateway_start",
      expect.anything(),
    );
  });

  it("logs a warning when projects.json is invalid JSON, then logs boot", async () => {
    const { api, getHandler } = makeApi();
    registerGatewayLifecycleHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue("not valid json {{{");
    mockAuditLog.mockResolvedValue(undefined);

    await handler({ port: 18789 }, { port: 18789 });

    expect(mockAuditLog).toHaveBeenCalledWith(
      workspaceDir,
      "gateway_start_warning",
      expect.objectContaining({ message: expect.stringContaining("projects.json") }),
    );
    // Boot log should still be written after warning
    expect(mockAuditLog).toHaveBeenCalledWith(
      workspaceDir,
      "gateway_start",
      expect.objectContaining({ port: 18789 }),
    );
  });

  it("logs a warning when projects.json is missing, then logs boot", async () => {
    const { api, getHandler } = makeApi();
    registerGatewayLifecycleHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    mockAuditLog.mockResolvedValue(undefined);

    await handler({ port: 18789 }, { port: 18789 });

    expect(mockAuditLog).toHaveBeenCalledWith(
      workspaceDir,
      "gateway_start_warning",
      expect.objectContaining({ message: expect.stringContaining("projects.json") }),
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      workspaceDir,
      "gateway_start",
      expect.objectContaining({ port: 18789 }),
    );
  });

  it("handles missing workspace gracefully — no crash even if auditLog throws", async () => {
    const { api, getHandler } = makeApi();
    registerGatewayLifecycleHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    mockAccess.mockRejectedValue(new Error("ENOENT"));
    mockAuditLog.mockRejectedValue(new Error("disk full"));

    await expect(handler({ port: 18789 }, { port: 18789 })).resolves.toBeUndefined();
  });
});
