import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequestHeartbeatNow = vi.fn();

describe("reactive-dispatch-hook", () => {
  function captureHandlers(register: (api: any, ctx: any) => void) {
    const handlers: Record<string, any> = {};
    const api = {
      on: vi.fn((name: string, h: any) => { handlers[name] = h; }),
    };
    const ctx = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runtime: {
        system: { requestHeartbeatNow: mockRequestHeartbeatNow },
      },
    };
    register(api as any, ctx as any);
    return handlers;
  }

  beforeEach(() => { vi.clearAllMocks(); });

  describe("after_tool_call", () => {
    it("calls requestHeartbeatNow when toolName is work_finish", async () => {
      const { registerReactiveDispatchHooks } = await import("../../lib/dispatch/reactive-dispatch-hook.js");
      const h = captureHandlers(registerReactiveDispatchHooks);

      await h["after_tool_call"]({ toolName: "work_finish", params: {} }, {});

      expect(mockRequestHeartbeatNow).toHaveBeenCalledOnce();
      expect(mockRequestHeartbeatNow).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "work_finish" }),
      );
    });

    it("calls requestHeartbeatNow when toolName is review_submit", async () => {
      const { registerReactiveDispatchHooks } = await import("../../lib/dispatch/reactive-dispatch-hook.js");
      const h = captureHandlers(registerReactiveDispatchHooks);

      await h["after_tool_call"]({ toolName: "review_submit", params: {} }, {});

      expect(mockRequestHeartbeatNow).toHaveBeenCalledOnce();
    });

    it("does NOT call requestHeartbeatNow for unrelated tools", async () => {
      const { registerReactiveDispatchHooks } = await import("../../lib/dispatch/reactive-dispatch-hook.js");
      const h = captureHandlers(registerReactiveDispatchHooks);

      await h["after_tool_call"]({ toolName: "gh_issue_list", params: {} }, {});

      expect(mockRequestHeartbeatNow).not.toHaveBeenCalled();
    });
  });

  describe("agent_end", () => {
    it("calls requestHeartbeatNow for a Fabrica worker session", async () => {
      const { registerReactiveDispatchHooks } = await import("../../lib/dispatch/reactive-dispatch-hook.js");
      const h = captureHandlers(registerReactiveDispatchHooks);

      await h["agent_end"](
        { success: true },
        { sessionKey: "agent:main:subagent:my-project-developer-junior-ada" },
      );

      expect(mockRequestHeartbeatNow).toHaveBeenCalledOnce();
      expect(mockRequestHeartbeatNow).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "agent_end" }),
      );
    });

    it("does NOT call requestHeartbeatNow for a non-Fabrica session", async () => {
      const { registerReactiveDispatchHooks } = await import("../../lib/dispatch/reactive-dispatch-hook.js");
      const h = captureHandlers(registerReactiveDispatchHooks);

      await h["agent_end"]({ success: true }, { sessionKey: "agent:main:main" });

      expect(mockRequestHeartbeatNow).not.toHaveBeenCalled();
    });

    it("does NOT call requestHeartbeatNow when sessionKey is missing", async () => {
      const { registerReactiveDispatchHooks } = await import("../../lib/dispatch/reactive-dispatch-hook.js");
      const h = captureHandlers(registerReactiveDispatchHooks);

      await h["agent_end"]({ success: false }, {});

      expect(mockRequestHeartbeatNow).not.toHaveBeenCalled();
    });
  });

  describe("subagent_spawned", () => {
    it("records spawn time and getSpawnTime returns it", async () => {
      const { registerReactiveDispatchHooks, getSpawnTime } = await import("../../lib/dispatch/reactive-dispatch-hook.js");
      const h = captureHandlers(registerReactiveDispatchHooks);

      const sessionKey = "agent:main:subagent:my-project-developer-junior-ada";
      const before = Date.now();
      await h["subagent_spawned"]({ childSessionKey: sessionKey, runId: "run-1" }, {});
      const after = Date.now();

      const spawnTime = getSpawnTime(sessionKey);
      expect(spawnTime).toBeDefined();
      expect(spawnTime!).toBeGreaterThanOrEqual(before);
      expect(spawnTime!).toBeLessThanOrEqual(after);
    });

    it("returns undefined for unknown session", async () => {
      const { getSpawnTime } = await import("../../lib/dispatch/reactive-dispatch-hook.js");

      expect(getSpawnTime("agent:main:subagent:unknown-developer-junior-xyz")).toBeUndefined();
    });
  });

  describe("deduplication behavior", () => {
    it("calls requestHeartbeatNow twice when two after_tool_call events fire within 100ms", async () => {
      // The SDK's coalesceMs deduplication is built-in at the wake-handler level.
      // From the hook's perspective, we call requestHeartbeatNow each time — the SDK
      // coalesces the actual heartbeat ticks. This test documents that behavior.
      const { registerReactiveDispatchHooks } = await import("../../lib/dispatch/reactive-dispatch-hook.js");
      const h = captureHandlers(registerReactiveDispatchHooks);

      await h["after_tool_call"]({ toolName: "work_finish", params: {} }, {});
      await h["after_tool_call"]({ toolName: "work_finish", params: {} }, {});

      // Hook calls requestHeartbeatNow twice; SDK coalesces at the runtime level.
      expect(mockRequestHeartbeatNow).toHaveBeenCalledTimes(2);
    });
  });
});
