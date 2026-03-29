import { describe, it, expect, vi } from "vitest";

// We'll test the hook handler function directly
// The hook is registered via api.on("before_agent_start", handler)
// We test by calling the handler with mock event + ctx

describe("worker-context-hook — before_agent_start", () => {
  // Mock api.on to capture the registered handler
  function captureHandler(
    register: (api: any, ctx: any) => void,
  ): (event: any, ctx: any) => Promise<any> {
    let captured: any;
    const api = { on: vi.fn((name: string, h: any) => { captured = h; }) };
    const ctx = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runtime: undefined,
    };
    register(api as any, ctx as any);
    return captured;
  }

  it("returns prependSystemContext with 'work_finish' for a Fabrica worker session", async () => {
    const { registerWorkerContextHook } = await import("../../lib/dispatch/worker-context-hook.js");
    const handler = captureHandler(registerWorkerContextHook);

    const result = await handler(
      { prompt: "do the task" },
      { sessionKey: "agent:main:subagent:my-project-developer-junior-ada" },
    );

    expect(result).toBeDefined();
    expect(result.prependSystemContext).toContain("work_finish");
    expect(result.prependSystemContext).toContain("MUST");
  });

  it("returns prependSystemContext with 'MUST call' for reviewer session", async () => {
    const { registerWorkerContextHook } = await import("../../lib/dispatch/worker-context-hook.js");
    const handler = captureHandler(registerWorkerContextHook);

    const result = await handler(
      { prompt: "review the pr" },
      { sessionKey: "agent:main:subagent:my-project-reviewer-junior-bob" },
    );

    expect(result?.prependSystemContext).toContain("MUST call");
  });

  it("returns void for a non-Fabrica session (main agent)", async () => {
    const { registerWorkerContextHook } = await import("../../lib/dispatch/worker-context-hook.js");
    const handler = captureHandler(registerWorkerContextHook);

    const result = await handler(
      { prompt: "hello" },
      { sessionKey: "agent:main:main" },
    );

    expect(result).toBeUndefined();
  });

  it("returns void when sessionKey is missing", async () => {
    const { registerWorkerContextHook } = await import("../../lib/dispatch/worker-context-hook.js");
    const handler = captureHandler(registerWorkerContextHook);

    const result = await handler({ prompt: "hello" }, {});

    expect(result).toBeUndefined();
  });
});
