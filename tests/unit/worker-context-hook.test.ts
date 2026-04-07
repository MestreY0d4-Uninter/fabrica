import { describe, it, expect, vi } from "vitest";

// We'll test the hook handler function directly
// The hook is registered via api.on("before_agent_start", handler)
// We test by calling the handler with mock event + ctx

describe("worker-context-hook — before_agent_start", () => {
  function getSection(content: string, heading: string): string {
    const start = content.indexOf(heading);
    if (start < 0) return "";

    const nextHeading = content.indexOf("\n## ", start + heading.length);
    return nextHeading < 0 ? content.slice(start) : content.slice(start, nextHeading);
  }

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

  it("returns developer completion context with canonical result lines", async () => {
    const { registerWorkerContextHook } = await import("../../lib/dispatch/worker-context-hook.js");
    const handler = captureHandler(registerWorkerContextHook);

    const result = await handler(
      { prompt: "do the task" },
      { sessionKey: "agent:main:subagent:my-project-developer-junior-ada" },
    );

    expect(result).toBeDefined();
    expect(result.prependSystemContext).toContain("Work result: DONE");
    expect(result.prependSystemContext).toContain("Work result: BLOCKED");
    expect(result.prependSystemContext).not.toContain("work_finish");
  });

  it("returns tester completion context with fail_infra guidance", async () => {
    const { registerWorkerContextHook } = await import("../../lib/dispatch/worker-context-hook.js");
    const handler = captureHandler(registerWorkerContextHook);

    const result = await handler(
      { prompt: "run the qa flow" },
      { sessionKey: "agent:main:subagent:my-project-tester-junior-riley" },
    );

    expect(result?.prependSystemContext).toContain("Test result: PASS");
    expect(result?.prependSystemContext).toContain("Test result: FAIL");
    expect(result?.prependSystemContext).toContain("Test result: FAIL_INFRA");
    expect(result?.prependSystemContext).toContain("Test result: BLOCKED");
    expect(result?.prependSystemContext).not.toContain("work_finish");
  });

  it("injects the execution contract for all worker roles", async () => {
    const { registerWorkerContextHook } = await import("../../lib/dispatch/worker-context-hook.js");
    const handler = captureHandler(registerWorkerContextHook);

    const roles = [
      ["developer", "agent:main:subagent:my-project-developer-junior-ada"],
      ["tester", "agent:main:subagent:my-project-tester-junior-riley"],
      ["reviewer", "agent:main:subagent:my-project-reviewer-junior-bob"],
      ["architect", "agent:main:subagent:my-project-architect-junior-ivy"],
    ] as const;

    for (const [role, sessionKey] of roles) {
      const result = await handler(
        { prompt: `run the ${role} flow` },
        { sessionKey },
      );

      const executionContract = getSection(result?.prependSystemContext ?? "", "## Execution Contract");

      expect(executionContract).toContain("nested coding agents");
      expect(executionContract).toContain("planning or meta-skills");
      expect(executionContract).toContain("another coding agent");
      expect(executionContract).toMatch(/Do not leave the assigned worktree execution path\./);

      if (role === "reviewer") {
        expect(executionContract).toContain("execute the review directly");
        expect(executionContract).toContain("Keep review verdict semantics pure");
        expect(executionContract).toContain("Review result: APPROVE");
        expect(executionContract).toContain("Review result: REJECT");
      } else {
        expect(executionContract).toContain("canonical scripts/qa.sh contract");
        expect(executionContract).toContain("lint, types, security, tests, and coverage");
        expect(executionContract).toContain("execute the task directly");
        expect(executionContract).toMatch(/canonical blocked result line/i);
      }
    }
  });

  it("keeps the reviewer task completion section aligned to supported verdicts", async () => {
    const { registerWorkerContextHook } = await import("../../lib/dispatch/worker-context-hook.js");
    const handler = captureHandler(registerWorkerContextHook);

    const result = await handler(
      { prompt: "review the pr" },
      { sessionKey: "agent:main:subagent:my-project-reviewer-junior-bob" },
    );

    const taskCompletion = getSection(result?.prependSystemContext ?? "", "## Task Completion");

    expect(taskCompletion).toContain("Review result: APPROVE");
    expect(taskCompletion).toContain("Review result: REJECT");
    expect(taskCompletion).not.toContain("do not emit a `Review result` line");
    expect(taskCompletion).not.toContain("blocked result line");
  });

  it("returns reviewer-specific completion context without work_finish", async () => {
    const { registerWorkerContextHook } = await import("../../lib/dispatch/worker-context-hook.js");
    const handler = captureHandler(registerWorkerContextHook);

    const result = await handler(
      { prompt: "review the pr" },
      { sessionKey: "agent:main:subagent:my-project-reviewer-junior-bob" },
    );

    expect(result?.prependSystemContext).toContain("Review result:");
    expect(result?.prependSystemContext).not.toContain("work_finish");
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
