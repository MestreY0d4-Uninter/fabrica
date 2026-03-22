import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerTelegramBootstrapHook } from "../../lib/dispatch/telegram-bootstrap-hook.js";

const {
  mockRunPipeline,
  mockReadProjects,
  mockProjectTick,
  mockDiscoverAgents,
} = vi.hoisted(() => ({
  mockRunPipeline: vi.fn(),
  mockReadProjects: vi.fn(),
  mockProjectTick: vi.fn(),
  mockDiscoverAgents: vi.fn(),
}));

vi.mock("../../lib/intake/index.js", () => ({
  runPipeline: mockRunPipeline,
}));

vi.mock("../../lib/projects/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/projects/index.js")>();
  return {
    ...actual,
    readProjects: mockReadProjects,
  };
});

vi.mock("../../lib/services/tick.js", () => ({
  projectTick: mockProjectTick,
}));

vi.mock("../../lib/services/heartbeat/agent-discovery.js", () => ({
  discoverAgents: mockDiscoverAgents,
}));

describe("telegram bootstrap hook", () => {
  let handler: ((event: any, eventCtx: any) => Promise<void>) | undefined;
  let beforePromptBuildHandler: ((event: any, eventCtx: any) => Promise<any>) | undefined;
  const sendMessageTelegram = vi.fn(async () => undefined);

  const ctx = {
    pluginConfig: {
      telegram: {
        bootstrapDmEnabled: true,
        projectsForumChatId: "-1003709213169",
      },
    },
    config: {
      agents: {
        defaults: {
          workspace: "/tmp/workspace",
        },
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    runtime: {
      channel: {
        telegram: {
          sendMessageTelegram,
        },
      },
    },
    runCommand: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
  } as any;

  beforeEach(async () => {
    handler = undefined;
    beforePromptBuildHandler = undefined;
    sendMessageTelegram.mockClear();
    mockRunPipeline.mockReset();
    mockReadProjects.mockReset();
    mockProjectTick.mockReset();
    mockDiscoverAgents.mockReset();
    mockReadProjects.mockResolvedValue({ projects: {} });
    mockDiscoverAgents.mockReturnValue([{ agentId: "main", workspace: "/tmp/workspace" }]);
    mockProjectTick.mockResolvedValue({ pickups: [], skipped: [] });
    await fs.rm("/tmp/workspace/fabrica/bootstrap-sessions", { recursive: true, force: true });
  });

  it("asks for clarification in DM when required fields are missing", async () => {
    const api = {
      on: vi.fn((name, fn) => {
        if (name === "message_received") handler = fn;
        if (name === "before_prompt_build") beforePromptBuildHandler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    registerTelegramBootstrapHook(api, ctx);
    expect(handler).toBeTypeOf("function");

    await handler?.(
      { content: "Crie um projeto novo para uma CLI", metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    expect(mockRunPipeline).not.toHaveBeenCalled();
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect(sendMessageTelegram.mock.calls[0]?.[0]).toBe("6951571380");
    // Conversational clarification message — not a form
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).toContain("stack");
  });

  it("suppresses the generic agent prompt when a bootstrap session is active", async () => {
    const api = {
      on: vi.fn((name, fn) => {
        if (name === "message_received") handler = fn;
        if (name === "before_prompt_build") beforePromptBuildHandler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    registerTelegramBootstrapHook(api, ctx);

    await handler?.(
      { content: "Crie um projeto novo para uma CLI", metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    const result = await beforePromptBuildHandler?.({}, {
      channelId: "telegram",
      conversationId: "6951571380",
    });

    expect(result?.prependSystemContext).toContain("handled out-of-band");
    expect(result?.prependSystemContext).toContain("NO_REPLY");
  });

  it("runs the intake pipeline and acknowledges the created topic for a complete DM request", async () => {
    const api = {
      on: vi.fn((name, fn) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    registerTelegramBootstrapHook(api, ctx);

    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          channel_id: "-1003709213169",
          message_thread_id: 777,
          project_slug: "demo-cli",
        },
      },
    });

    await handler?.(
      {
        content: [
          "Crie e registre um novo projeto.",
          "Project name: demo-cli",
          "Stack: python-cli",
          "Idea:",
          "Uma CLI para gerar senhas.",
        ].join("\n"),
        metadata: {},
      },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(mockRunPipeline.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      raw_idea: expect.stringContaining("Uma CLI para gerar senhas."),
      metadata: expect.objectContaining({
        source: "telegram-dm-bootstrap",
        project_name: "demo-cli",
        stack_hint: "python-cli",
        channel_id: "6951571380",
        repo_url: null,
      }),
    }));
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(mockProjectTick).toHaveBeenCalledTimes(1);
    expect(sendMessageTelegram.mock.calls[0]?.[0]).toBe("-1003709213169");
    expect(sendMessageTelegram.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      messageThreadId: 777,
    }));
    expect(sendMessageTelegram.mock.calls[1]?.[0]).toBe("6951571380");
    expect(String(sendMessageTelegram.mock.calls[1]?.[1])).toContain("Projeto \"demo-cli\" registrado.");
  });

  it("ignores duplicate in-flight bootstrap requests with the same full request fingerprint", async () => {
    const api = {
      on: vi.fn((name, fn) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    registerTelegramBootstrapHook(api, ctx);

    // Use a complete request (with Stack) so first call goes directly to pipeline
    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          channel_id: "-1003709213169",
          message_thread_id: 777,
          project_slug: "demo-cli",
        },
      },
    });

    const completeContent = [
      "Crie e registre um novo projeto.",
      "Project name: demo-cli",
      "Stack: python-cli",
      "Idea:",
      "Uma CLI para gerar senhas.",
    ].join("\n");

    await handler?.(
      { content: completeContent, metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );
    // Wait for first pipeline to complete and write "completed" status to session file
    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(2), { timeout: 2000 });

    // Second identical message — same request hash, status is "completed" → deduplicated
    await handler?.(
      { content: completeContent, metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    // Pipeline called exactly once; second message was deduplicated
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    // 2 sends from the first call (topic kickoff + DM ack); none from the second
    expect(sendMessageTelegram).toHaveBeenCalledTimes(2);
  });

  it("reprocesses a completed DM when the full request changes even if the idea stays the same", async () => {
    const api = {
      on: vi.fn((name, fn) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    registerTelegramBootstrapHook(api, ctx);

    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          channel_id: "-1003709213169",
          message_thread_id: 777,
          project_slug: "demo-cli",
        },
      },
    });

    const sharedIdea = "Uma CLI para gerar senhas.";
    await handler?.(
      {
        content: [
          "Crie e registre um novo projeto.",
          "Project name: demo-cli",
          "Stack: python-cli",
          "Idea:",
          sharedIdea,
        ].join("\n"),
        metadata: {},
      },
      { channelId: "telegram", conversationId: "6951571380" },
    );
    // Wait for first pipeline to complete before sending different request
    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });

    await handler?.(
      {
        content: [
          "Crie e registre um novo projeto.",
          "Project name: demo-cli",
          "Stack: express",
          "Idea:",
          sharedIdea,
        ].join("\n"),
        metadata: {},
      },
      { channelId: "telegram", conversationId: "6951571380" },
    );
    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });

  it("fails closed when pipeline succeeds without topic routing", async () => {
    const api = {
      on: vi.fn((name, fn) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    registerTelegramBootstrapHook(api, ctx);

    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          project_slug: "demo-cli",
        },
      },
    });

    await handler?.(
      {
        content: [
          "Crie e registre um novo projeto.",
          "Project name: demo-cli",
          "Stack: python-cli",
          "Idea:",
          "Uma CLI para gerar senhas.",
        ].join("\n"),
        metadata: {},
      },
      { channelId: "telegram", conversationId: "6951571380" },
    );
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).toContain("faltou a associacao obrigatoria com um topico Telegram");
    expect(mockProjectTick).not.toHaveBeenCalled();
  });

  it("infers the project name from the DM when the user does not provide one explicitly", async () => {
    const api = {
      on: vi.fn((name, fn) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    registerTelegramBootstrapHook(api, ctx);

    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          channel_id: "-1003709213169",
          message_thread_id: 778,
        },
      },
    });

    await handler?.(
      {
        content: [
          "Crie um projeto novo.",
          "Stack: python-cli",
          "Idea:",
          "Uma CLI em Python que gere senhas aleatorias no terminal.",
        ].join("\n"),
        metadata: {},
      },
      { channelId: "telegram", conversationId: "6951571380" },
    );
    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(mockRunPipeline.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      raw_idea: "Uma CLI em Python que gere senhas aleatorias no terminal.",
      metadata: expect.objectContaining({
        project_name: null,
        stack_hint: "python-cli",
      }),
    }));
  });

  it("detects node-cli from natural TypeScript CLI language instead of falling back to express", async () => {
    const api = {
      on: vi.fn((name, fn) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    registerTelegramBootstrapHook(api, ctx);

    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          channel_id: "-1003709213169",
          message_thread_id: 781,
          project_slug: "demo-node-cli",
        },
      },
    });

    await handler?.(
      {
        content: [
          "Crie e registre um novo projeto.",
          "Project name: demo-node-cli",
          "Idea:",
          "Quero uma CLI em TypeScript para gerar senhas aleatorias no terminal.",
        ].join("\n"),
        metadata: {},
      },
      { channelId: "telegram", conversationId: "6951571380" },
    );
    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(mockRunPipeline.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({
        project_name: "demo-node-cli",
        stack_hint: "node-cli",
      }),
    }));
  });

  it("fails closed when the pipeline returns success without a project topic", async () => {
    const api = {
      on: vi.fn((name, fn) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    registerTelegramBootstrapHook(api, ctx);

    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          channel_id: "-1003709213169",
          project_slug: "demo-cli",
        },
      },
    });

    await handler?.(
      {
        content: [
          "Crie e registre um novo projeto.",
          "Project name: demo-cli",
          "Stack: python-cli",
          "Idea:",
          "Uma CLI para gerar senhas.",
        ].join("\n"),
        metadata: {},
      },
      { channelId: "telegram", conversationId: "6951571380" },
    );
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(sendMessageTelegram.mock.calls[0]?.[0]).toBe("6951571380");
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).toContain("faltou a associacao obrigatoria com um topico Telegram");
  });
});
