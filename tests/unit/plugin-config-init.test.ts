import { describe, it, expect, vi, beforeEach } from "vitest";

// Module-level spy so the hoisted vi.mock factory can reference it
const warnSpy = vi.fn();

vi.mock("../../lib/observability/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/observability/logger.js")>();
  return {
    ...actual,
    getLogger: () => ({
      warn: warnSpy,
      info: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnValue({
        warn: warnSpy,
        info: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
      }),
    }),
  };
});

// Import after mock registration
const { createPluginContext } = await import("../../lib/context.js");

function makeApi(pluginConfig: Record<string, unknown> = {}) {
  return {
    pluginConfig,
    config: {},
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    runtime: {
      system: { runCommandWithTimeout: vi.fn() },
      subagent: { run: vi.fn() },
    },
  } as any;
}

describe("createPluginContext — pluginConfig validation", () => {
  beforeEach(() => {
    warnSpy.mockClear();
  });

  it("does NOT warn for valid config", () => {
    const api = makeApi({
      work_heartbeat: { enabled: true, intervalSeconds: 60, maxPickupsPerTick: 4 },
      providers: { github: { webhookMode: "optional" } },
      telegram: { bootstrapDmEnabled: true },
    });
    createPluginContext(api);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("fails closed for invalid material pluginConfig", () => {
    const api = makeApi({ work_heartbeat: { enabled: "not-a-boolean" } });

    expect(() => createPluginContext(api)).toThrow(/pluginConfig validation failed/i);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn for empty config (no validation needed)", () => {
    const api = makeApi({});
    createPluginContext(api);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
