import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerModelResolveHook } from "../../lib/dispatch/model-resolve-hook.js";

// Hoist mocks before any imports are resolved
const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      promises: {
        ...actual.promises,
        readFile: mockReadFile,
      },
    },
    promises: {
      ...actual.promises,
      readFile: mockReadFile,
    },
  };
});

const workspaceDir = "/tmp/test-workspace";

function makeApi() {
  let handler: ((event: any, ctx: any) => Promise<any>) | undefined;
  const api = {
    on: vi.fn((hookName: string, h: any) => {
      if (hookName === "before_model_resolve") handler = h;
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

/**
 * Build a minimal projects.json with a slot that has the given lastFailureReason.
 */
function makeProjectsJson(
  projectSlug: string,
  role: string,
  level: string,
  sessionKey: string,
  lastFailureReason?: string,
) {
  const slot: Record<string, any> = { sessionKey };
  if (lastFailureReason) {
    slot.runtimeState = { lastFailureReason };
  }
  return JSON.stringify({
    "proj-id": {
      slug: projectSlug,
      workers: {
        [role]: {
          levels: {
            [level]: [slot],
          },
        },
      },
    },
  });
}

describe("before_model_resolve hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers a before_model_resolve hook via api.on when workspace is configured", () => {
    const { api } = makeApi();
    registerModelResolveHook(api, makeCtx(workspaceDir));
    expect(api.on).toHaveBeenCalledWith("before_model_resolve", expect.any(Function));
  });

  it("does not register hook when workspaceDir cannot be resolved", () => {
    const { api } = makeApi();
    registerModelResolveHook(api, makeCtx(undefined));
    expect(api.on).not.toHaveBeenCalled();
  });

  it("overrides model when lastFailureReason is complexity (junior → medior)", async () => {
    const { api, getHandler } = makeApi();
    registerModelResolveHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    const sessionKey = "agent:fabrica:subagent:my-project-developer-junior-ada";
    mockReadFile.mockResolvedValue(
      makeProjectsJson("my-project", "developer", "junior", sessionKey, "complexity"),
    );

    const result = await handler({ prompt: "do some work" }, { sessionKey });

    expect(result).toEqual({ modelOverride: expect.stringContaining("mini") });
  });

  it("overrides model when lastFailureReason is complexity (medior → senior)", async () => {
    const { api, getHandler } = makeApi();
    registerModelResolveHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    const sessionKey = "agent:fabrica:subagent:my-project-developer-medior-ada";
    mockReadFile.mockResolvedValue(
      makeProjectsJson("my-project", "developer", "medior", sessionKey, "complexity"),
    );

    const result = await handler({ prompt: "do some work" }, { sessionKey });

    // medior → senior: senior model does not contain "mini"
    expect(result).toEqual({ modelOverride: expect.any(String) });
    expect(result.modelOverride).not.toContain("mini");
  });

  it("does nothing for sessions without failure history", async () => {
    const { api, getHandler } = makeApi();
    registerModelResolveHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    const sessionKey = "agent:fabrica:subagent:my-project-developer-medior-ada";
    mockReadFile.mockResolvedValue(
      makeProjectsJson("my-project", "developer", "medior", sessionKey),
    );

    const result = await handler({ prompt: "do some work" }, { sessionKey });

    expect(result).toBeUndefined();
  });

  it("does nothing for non-worker sessions (no sessionKey)", async () => {
    const { api, getHandler } = makeApi();
    registerModelResolveHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    const result = await handler({ prompt: "do some work" }, {});

    expect(result).toBeUndefined();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("does nothing for non-fabrica session keys", async () => {
    const { api, getHandler } = makeApi();
    registerModelResolveHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    // Session key that doesn't match the Fabrica worker pattern
    const result = await handler(
      { prompt: "do some work" },
      { sessionKey: "agent:fabrica:orchestrator" },
    );

    expect(result).toBeUndefined();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("does nothing for senior level (no escalation possible)", async () => {
    const { api, getHandler } = makeApi();
    registerModelResolveHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    const sessionKey = "agent:fabrica:subagent:my-project-developer-senior-ada";
    mockReadFile.mockResolvedValue(
      makeProjectsJson("my-project", "developer", "senior", sessionKey, "complexity"),
    );

    const result = await handler({ prompt: "do some work" }, { sessionKey });

    // senior has no escalation entry in ESCALATION_MAP
    expect(result).toBeUndefined();
  });

  it("does nothing when failure reason is not complexity", async () => {
    const { api, getHandler } = makeApi();
    registerModelResolveHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    const sessionKey = "agent:fabrica:subagent:my-project-developer-medior-ada";
    mockReadFile.mockResolvedValue(
      makeProjectsJson("my-project", "developer", "medior", sessionKey, "timeout"),
    );

    const result = await handler({ prompt: "do some work" }, { sessionKey });

    expect(result).toBeUndefined();
  });

  it("does nothing when slot sessionKey does not match", async () => {
    const { api, getHandler } = makeApi();
    registerModelResolveHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    const sessionKey = "agent:fabrica:subagent:my-project-developer-medior-ada";
    // Slot has a different sessionKey
    mockReadFile.mockResolvedValue(
      makeProjectsJson("my-project", "developer", "medior", "different-session-key", "complexity"),
    );

    const result = await handler({ prompt: "do some work" }, { sessionKey });

    expect(result).toBeUndefined();
  });

  it("does not throw when readFile fails (best-effort)", async () => {
    const { api, getHandler } = makeApi();
    registerModelResolveHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    mockReadFile.mockRejectedValue(new Error("ENOENT: no such file"));

    const sessionKey = "agent:fabrica:subagent:my-project-developer-medior-ada";
    await expect(
      handler({ prompt: "do some work" }, { sessionKey }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when projects.json is invalid JSON (best-effort)", async () => {
    const { api, getHandler } = makeApi();
    registerModelResolveHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    mockReadFile.mockResolvedValue("not valid json {{{");

    const sessionKey = "agent:fabrica:subagent:my-project-developer-medior-ada";
    await expect(
      handler({ prompt: "do some work" }, { sessionKey }),
    ).resolves.toBeUndefined();
  });

  it("handles session keys with hyphenated project names", async () => {
    const { api, getHandler } = makeApi();
    registerModelResolveHook(api, makeCtx(workspaceDir));
    const handler = getHandler()!;

    const sessionKey = "agent:fabrica:subagent:my-cool-app-developer-junior-0";
    mockReadFile.mockResolvedValue(
      makeProjectsJson("my-cool-app", "developer", "junior", sessionKey, "complexity"),
    );

    const result = await handler({ prompt: "do some work" }, { sessionKey });

    expect(result).toEqual({ modelOverride: expect.any(String) });
  });
});
