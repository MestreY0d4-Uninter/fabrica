import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuditLog,
  mockLoadConfig,
  mockDiscoverAgents,
  mockFetchGatewaySessions,
  mockTick,
  mockEnsureDefaultFiles,
  mockProcessPendingGitHubEventsForWorkspace,
  mockGetLifecycleService,
  mockRecoverDueTelegramBootstrapSessions,
  mockRaceWithTimeout,
} = vi.hoisted(() => ({
  mockAuditLog: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockDiscoverAgents: vi.fn(),
  mockFetchGatewaySessions: vi.fn(),
  mockTick: vi.fn(),
  mockEnsureDefaultFiles: vi.fn(),
  mockProcessPendingGitHubEventsForWorkspace: vi.fn(),
  mockGetLifecycleService: vi.fn(),
  mockRecoverDueTelegramBootstrapSessions: vi.fn(),
  mockRaceWithTimeout: vi.fn(),
}));

vi.mock("../../lib/audit.js", () => ({
  log: mockAuditLog,
}));

vi.mock("../../lib/config/index.js", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("../../lib/services/heartbeat/agent-discovery.js", () => ({
  discoverAgents: mockDiscoverAgents,
}));

vi.mock("../../lib/services/heartbeat/health.js", () => ({
  fetchGatewaySessions: mockFetchGatewaySessions,
}));

vi.mock("../../lib/services/heartbeat/tick-runner.js", () => ({
  tick: mockTick,
}));

vi.mock("../../lib/setup/workspace.js", () => ({
  ensureDefaultFiles: mockEnsureDefaultFiles,
}));

vi.mock("../../lib/github/process-events.js", () => ({
  processPendingGitHubEventsForWorkspace: mockProcessPendingGitHubEventsForWorkspace,
}));

vi.mock("../../lib/machines/lifecycle-service.js", () => ({
  getLifecycleService: mockGetLifecycleService,
}));

vi.mock("../../lib/dispatch/telegram-bootstrap-hook.js", () => ({
  recoverDueTelegramBootstrapSessions: mockRecoverDueTelegramBootstrapSessions,
}));

vi.mock("../../lib/utils/async.js", () => ({
  raceWithTimeout: mockRaceWithTimeout,
}));

function makeApi() {
  let service: { start: (ctx: any) => Promise<void>; stop: (ctx: any) => Promise<void> } | null = null;
  return {
    api: {
      registerService(definition: { start: (ctx: any) => Promise<void>; stop: (ctx: any) => Promise<void> }) {
        service = definition;
      },
    },
    getService() {
      if (!service) throw new Error("service not registered");
      return service;
    },
  };
}

function makePluginCtx() {
  return {
    config: {
      agents: {
        defaults: { workspace: "/tmp/fabrica-runtime-audit" },
        list: [{ id: "main", workspace: "/tmp/fabrica-runtime-audit" }],
      },
    },
    pluginConfig: {
      work_heartbeat: { enabled: true, intervalSeconds: 60 },
    },
    observability: {
      withContext: (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
      withSpan: (_name: string, _attrs: unknown, fn: () => Promise<unknown>) => fn(),
    },
    runCommand: vi.fn(),
    runtime: undefined,
  };
}

function makeServiceCtx() {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    config: {
      agents: {
        defaults: { workspace: "/tmp/fabrica-runtime-audit" },
        list: [{ id: "main", workspace: "/tmp/fabrica-runtime-audit" }],
      },
    },
  };
}

describe("heartbeat runtime audit logging", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.resetModules();

    mockAuditLog.mockResolvedValue(undefined);
    mockLoadConfig.mockResolvedValue({ timeouts: { tickTimeoutMs: 50_000 } });
    mockDiscoverAgents.mockReturnValue([{ agentId: "main", workspace: "/tmp/fabrica-runtime-audit" }]);
    mockFetchGatewaySessions.mockResolvedValue(new Map());
    mockTick.mockResolvedValue({
      totalPickups: 0,
      totalHealthFixes: 0,
      totalSkipped: 0,
      totalReviewTransitions: 0,
      totalReviewSkipTransitions: 0,
      totalTestSkipTransitions: 0,
      totalHoldEscapes: 0,
    });
    mockEnsureDefaultFiles.mockResolvedValue(undefined);
    mockProcessPendingGitHubEventsForWorkspace.mockResolvedValue(undefined);
    mockGetLifecycleService.mockResolvedValue(null);
    mockRecoverDueTelegramBootstrapSessions.mockResolvedValue(0);
    mockRaceWithTimeout.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it("audits heartbeat service start and stop for configured workspaces", async () => {
    const { api, getService } = makeApi();
    const pluginCtx = makePluginCtx();
    const svcCtx = makeServiceCtx();

    const { registerHeartbeatService } = await import("../../lib/services/heartbeat/index.js?audit-start-stop-" + Date.now());
    registerHeartbeatService(api as any, pluginCtx as any);

    const service = getService();
    await service.start(svcCtx);
    await service.stop(svcCtx);

    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/fabrica-runtime-audit",
      "heartbeat_service_started",
      expect.objectContaining({
        intervalSeconds: 60,
        intervalMs: 60_000,
      }),
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/fabrica-runtime-audit",
      "heartbeat_service_stopped",
      {},
    );
  });

  it("audits timeout incidents when a heartbeat tick times out", async () => {
    mockRaceWithTimeout.mockImplementation(async (
      fn: () => Promise<unknown>,
      _timeoutMs: number,
      onTimeout: () => void,
    ) => {
      const pending = fn();
      onTimeout();
      await pending;
      return "timeout";
    });

    const { api, getService } = makeApi();
    const pluginCtx = makePluginCtx();
    const svcCtx = makeServiceCtx();

    const { registerHeartbeatService } = await import("../../lib/services/heartbeat/index.js?audit-timeout-" + Date.now());
    const { wakeHeartbeat } = await import("../../lib/services/heartbeat/wake-bridge.js");
    registerHeartbeatService(api as any, pluginCtx as any);

    const service = getService();
    await service.start(svcCtx);
    await wakeHeartbeat("timeout-test");
    await service.stop(svcCtx);

    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/fabrica-runtime-audit",
      "heartbeat_tick_timeout",
      expect.objectContaining({
        mode: "full",
        tickTimeoutMs: 50_000,
      }),
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/fabrica-runtime-audit",
      "heartbeat_tick_timeout_recovered",
      expect.objectContaining({
        mode: "full",
        tickTimeoutMs: 50_000,
      }),
    );
  });

  it("audits heartbeat tick failures", async () => {
    mockTick.mockRejectedValue(new Error("simulated tick failure"));

    const { api, getService } = makeApi();
    const pluginCtx = makePluginCtx();
    const svcCtx = makeServiceCtx();

    const { registerHeartbeatService } = await import("../../lib/services/heartbeat/index.js?audit-failure-" + Date.now());
    const { wakeHeartbeat } = await import("../../lib/services/heartbeat/wake-bridge.js");
    registerHeartbeatService(api as any, pluginCtx as any);

    const service = getService();
    await service.start(svcCtx);
    await wakeHeartbeat("failure-test");
    await service.stop(svcCtx);

    expect(mockAuditLog).toHaveBeenCalledWith(
      "/tmp/fabrica-runtime-audit",
      "heartbeat_tick_failed",
      expect.objectContaining({
        mode: "full",
        error: "simulated tick failure",
      }),
    );
  });
});
