import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequestHeartbeatNow = vi.fn();
const mockHandleWorkerAgentEnd = vi.fn();

vi.mock("../../lib/services/worker-completion.js", () => ({
  handleWorkerAgentEnd: mockHandleWorkerAgentEnd,
}));

describe("reactive-dispatch-hook", () => {
  function captureHandlers(register: (api: any, ctx: any) => void) {
    const handlers: Record<string, any> = {};
    const api = {
      on: vi.fn((name: string, h: any) => { handlers[name] = h; }),
    };
    const ctx = {
      config: { agents: { defaults: { workspace: "/tmp/fabrica-workspace" } } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runtime: {
        system: { requestHeartbeatNow: mockRequestHeartbeatNow },
      },
      runCommand: vi.fn(),
    };
    register(api as any, ctx as any);
    return handlers;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockHandleWorkerAgentEnd.mockResolvedValue({ applied: true });
  });

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

    it("does NOT call requestHeartbeatNow when toolName is review_submit", async () => {
      const { registerReactiveDispatchHooks } = await import("../../lib/dispatch/reactive-dispatch-hook.js");
      const h = captureHandlers(registerReactiveDispatchHooks);

      await h["after_tool_call"]({ toolName: "review_submit", params: {} }, {});

      expect(mockRequestHeartbeatNow).not.toHaveBeenCalled();
    });

    it("does NOT call requestHeartbeatNow for unrelated tools", async () => {
      const { registerReactiveDispatchHooks } = await import("../../lib/dispatch/reactive-dispatch-hook.js");
      const h = captureHandlers(registerReactiveDispatchHooks);

      await h["after_tool_call"]({ toolName: "gh_issue_list", params: {} }, {});

      expect(mockRequestHeartbeatNow).not.toHaveBeenCalled();
    });
  });

  describe("before_tool_call", () => {
    it("injects the trusted runId into work_finish params", async () => {
      const { registerReactiveDispatchHooks } = await import("../../lib/dispatch/reactive-dispatch-hook.js");
      const h = captureHandlers(registerReactiveDispatchHooks);

      const result = await h["before_tool_call"](
        { toolName: "work_finish", params: { role: "developer", result: "done" }, runId: "run-42" },
        { runId: "run-42", sessionKey: "agent:main:subagent:my-project-developer-junior-ada" },
      );

      expect(result).toEqual({
        params: {
          role: "developer",
          result: "done",
          _dispatchRunId: "run-42",
        },
      });
    });

    it("ignores unrelated tools in before_tool_call", async () => {
      const { registerReactiveDispatchHooks } = await import("../../lib/dispatch/reactive-dispatch-hook.js");
      const h = captureHandlers(registerReactiveDispatchHooks);

      const result = await h["before_tool_call"](
        { toolName: "task_create", params: { title: "x" }, runId: "run-42" },
        { runId: "run-42", sessionKey: "agent:main:subagent:my-project-developer-junior-ada" },
      );

      expect(result).toBeUndefined();
    });
  });

  describe("agent_end", () => {
    it("wakes heartbeat for reviewer sessions even though worker completion resolves as a no-op", async () => {
      const { registerReactiveDispatchHooks } = await import("../../lib/dispatch/reactive-dispatch-hook.js");
      const h = captureHandlers(registerReactiveDispatchHooks);

      await h["agent_end"](
        {
          success: true,
          messages: [{ role: "assistant", content: [{ type: "text", text: "Review result: REJECT" }] }],
        },
        { sessionKey: "agent:main:subagent:my-project-reviewer-junior-bob" },
      );

      expect(mockRequestHeartbeatNow).toHaveBeenCalledOnce();
      expect(mockRequestHeartbeatNow).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "agent_end" }),
      );
      expect(mockHandleWorkerAgentEnd).toHaveBeenCalledOnce();
    });

    it("applies worker completion before waking heartbeat for a Fabrica worker session", async () => {
      const { registerReactiveDispatchHooks } = await import("../../lib/dispatch/reactive-dispatch-hook.js");
      const h = captureHandlers(registerReactiveDispatchHooks);

      await h["agent_end"](
        { success: true, messages: [{ role: "assistant", content: [{ type: "text", text: "Work result: DONE" }] }] },
        { sessionKey: "agent:main:subagent:my-project-developer-junior-ada" },
      );

      expect(mockHandleWorkerAgentEnd).toHaveBeenCalledOnce();
      expect(mockHandleWorkerAgentEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:subagent:my-project-developer-junior-ada",
          workspaceDir: "/tmp/fabrica-workspace",
          messages: [{ role: "assistant", content: [{ type: "text", text: "Work result: DONE" }] }],
        }),
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
