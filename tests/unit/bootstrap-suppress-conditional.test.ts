import { describe, it, expect, vi } from "vitest";
import { registerTelegramBootstrapHook } from "../../lib/dispatch/telegram-bootstrap-hook.js";

// Mock heavy dependencies so module import does not stall.
vi.mock("../../lib/intake/index.js", () => ({ runPipeline: vi.fn() }));
vi.mock("../../lib/providers/index.js", () => ({ createProvider: vi.fn() }));
vi.mock("../../lib/projects/index.js", () => ({ readProjects: vi.fn() }));
vi.mock("../../lib/services/heartbeat/agent-discovery.js", () => ({ discoverAgents: vi.fn() }));
vi.mock("../../lib/services/tick.js", () => ({ projectTick: vi.fn() }));
vi.mock("../../lib/observability/logger.js", () => ({
  getRootLogger: () => ({ child: () => ({ info: vi.fn(), warn: vi.fn() }) }),
}));

// We test registerTelegramBootstrapHook indirectly by inspecting which
// api.on() calls are made based on genesis agent presence in config.

function makeApi(agents: Array<{ id: string }>) {
  const config = { agents: { list: agents } };
  const onCalls: string[] = [];
  return {
    on: vi.fn((event: string) => { onCalls.push(event); }),
    runtime: {
      config: {
        loadConfig: vi.fn(() => config),
      },
    },
    // expose for assertions
    _onCalls: onCalls,
  };
}

function makeCtx() {
  return {
    config: {},
    pluginConfig: {
      telegram: {
        bootstrapDmEnabled: true,
        projectsForumChatId: "-1003709213169",
      },
    },
    runtime: null,
  };
}

describe("registerTelegramBootstrapHook — conditional suppress", () => {
  it("registers all 3 hooks when NO genesis agent exists", () => {
    const api = makeApi([{ id: "main" }]);

    registerTelegramBootstrapHook(api as any, makeCtx() as any);

    expect(api._onCalls).toContain("before_prompt_build");
    expect(api._onCalls).toContain("message_sending");
    expect(api._onCalls).toContain("message_received");
  });

  it("keeps hooks active when genesis exists but the official forum config is missing", () => {
    const api = makeApi([{ id: "main" }, { id: "genesis" }]);
    const ctx = makeCtx();
    delete ctx.pluginConfig.telegram.projectsForumChatId;

    registerTelegramBootstrapHook(api as any, ctx as any);

    expect(api._onCalls).toContain("before_prompt_build");
    expect(api._onCalls).toContain("message_sending");
    expect(api._onCalls).toContain("message_received");
  });

  it("registers NO hooks when genesis exists and the official DM bootstrap flow is configured", () => {
    const api = makeApi([{ id: "main" }, { id: "genesis" }]);

    registerTelegramBootstrapHook(api as any, makeCtx() as any);

    expect(api._onCalls).not.toContain("before_prompt_build");
    expect(api._onCalls).not.toContain("message_sending");
    expect(api._onCalls).not.toContain("message_received");
  });
});
