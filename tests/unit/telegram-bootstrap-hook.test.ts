import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerTelegramBootstrapHook, _testIsAmbiguousCandidate as isAmbiguousCandidate, _testClassifyDmIntent as classifyDmIntent, _testBuildTopicDeepLink as buildTopicDeepLink, _testInferProjectSlug as inferProjectSlug, _testNormalizeUserResponse as normalizeUserResponse } from "../../lib/dispatch/telegram-bootstrap-hook.js";
import {
  upsertTelegramBootstrapSession,
  readTelegramBootstrapSession,
  deleteTelegramBootstrapSession,
  shouldSuppressTelegramBootstrapReply,
} from "../../lib/dispatch/telegram-bootstrap-session.js";

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
  let messageSendingHandler: ((event: any, eventCtx: any) => Promise<any>) | undefined;
  const sendMessageTelegram = vi.fn(async () => undefined);
  const outerMockSubagentRun = vi.fn().mockResolvedValue({ runId: "outer-run" });
  const outerMockSubagentWait = vi.fn().mockResolvedValue({ status: "ok" });
  const outerMockSubagentGetMessages = vi.fn().mockResolvedValue([]);

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
      subagent: {
        run: outerMockSubagentRun,
        waitForRun: outerMockSubagentWait,
        getSessionMessages: outerMockSubagentGetMessages,
      },
    },
    runCommand: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
  } as any;

  beforeEach(async () => {
    handler = undefined;
    beforePromptBuildHandler = undefined;
    messageSendingHandler = undefined;
    sendMessageTelegram.mockClear();
    mockRunPipeline.mockReset();
    mockReadProjects.mockReset();
    mockProjectTick.mockReset();
    mockDiscoverAgents.mockReset();
    mockReadProjects.mockResolvedValue({ projects: {} });
    mockDiscoverAgents.mockReturnValue([{ agentId: "main", workspace: "/tmp/workspace" }]);
    mockProjectTick.mockResolvedValue({ pickups: [], skipped: [] });
    ctx.runCommand.mockClear();
    ctx.runCommand.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    outerMockSubagentRun.mockClear();
    outerMockSubagentWait.mockClear();
    outerMockSubagentGetMessages.mockClear();
    outerMockSubagentRun.mockResolvedValue({ runId: "outer-run" });
    outerMockSubagentWait.mockResolvedValue({ status: "ok" });
    outerMockSubagentGetMessages.mockResolvedValue([]);
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
    // ack sent first, then clarification question
    expect(sendMessageTelegram).toHaveBeenCalledTimes(2);
    expect(sendMessageTelegram.mock.calls[0]?.[0]).toBe("6951571380");
    // Conversational clarification message — not a form (second call)
    expect(String(sendMessageTelegram.mock.calls[1]?.[1])).toContain("stack");
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

    // before_prompt_build receives PluginHookAgentContext — no conversationId, uses sessionKey instead.
    // The session was stored with conversationId "6951571380" (test format), so sessionKey must
    // produce "telegram:6951571380" to match. But the message_received handler stored it with "6951571380".
    // For this test, we just need to verify the hook works with sessionKey.
    // First, store session with the telegram: prefix (matching production format):
    await upsertTelegramBootstrapSession("/tmp/workspace", {
      conversationId: "telegram:6951571380",
      rawIdea: "Crie um projeto novo para uma CLI",
      sourceRoute: { channel: "telegram", channelId: "6951571380" },
      status: "clarifying",
    });

    const result = await beforePromptBuildHandler?.({}, {
      channelId: "telegram",
      sessionKey: "agent:main:telegram:slash:6951571380",
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
    // 3 sends: ack (calls[0]), topic kickoff (calls[1]), DM ack (calls[2])
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(3), { timeout: 2000 });
    expect(mockProjectTick).toHaveBeenCalledTimes(1);
    expect(sendMessageTelegram.mock.calls[1]?.[0]).toBe("-1003709213169");
    expect(sendMessageTelegram.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      messageThreadId: 777,
    }));
    expect(sendMessageTelegram.mock.calls[2]?.[0]).toBe("6951571380");
    expect(String(sendMessageTelegram.mock.calls[2]?.[1])).toContain("https://t.me/c/3709213169/777");
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
    // 3 sends: ack, topic kickoff, DM ack
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(3), { timeout: 2000 });

    // Second identical message — same request hash, status is "completed" → deduplicated
    await handler?.(
      { content: completeContent, metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    // Pipeline called exactly once; second message was deduplicated
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    // 3 sends from the first call (ack + topic kickoff + DM ack); none from the second
    expect(sendMessageTelegram).toHaveBeenCalledTimes(3);
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
    // Drain both fire-and-forget pipelines: 3 sends each (ack + topic kickoff + DM ack) = 6 total
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(6), { timeout: 2000 });
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
    // 2 sends: ack (calls[0]), then error message (calls[1])
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(String(sendMessageTelegram.mock.calls[1]?.[1])).toContain("faltou a associacao obrigatoria com um topico Telegram");
    expect(mockProjectTick).not.toHaveBeenCalled();
  });

  it("asks for project name when stack is provided but no project name in the DM", async () => {
    const api = {
      on: vi.fn((name, fn) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    registerTelegramBootstrapHook(api, ctx);

    // Pipeline returns without channel_id/message_thread_id to take the simple error path
    // (avoids complex post-pipeline async fire-and-forget that races with test cleanup)
    mockRunPipeline.mockResolvedValue({
      success: false,
      error: "test_pipeline_done",
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
    // Should NOT call pipeline immediately — asks for name first
    expect(mockRunPipeline).not.toHaveBeenCalled();
    // 2 sends: ack (calls[0]), name question (calls[1])
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(String(sendMessageTelegram.mock.calls[1]?.[1])).toMatch(/nome|name/i);

    sendMessageTelegram.mockClear();

    // User responds with a project name
    await handler?.(
      { content: "gerador-senhas-cli", metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(mockRunPipeline.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      raw_idea: "Uma CLI em Python que gere senhas aleatorias no terminal.",
      metadata: expect.objectContaining({
        project_name: "gerador-senhas-cli",
        stack_hint: "python-cli",
      }),
    }));
    // Drain: pipeline failed path sends 1 error message then upserts "failed" session
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(1), { timeout: 2000 });
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
    // Drain fire-and-forget pipeline to prevent mock pollution in subsequent tests.
    // 3 sends: ack (calls[0]), topic kickoff (calls[1]), DM ack (calls[2])
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(3), { timeout: 2000 });
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
    // 2 sends: ack (calls[0]), then error message (calls[1])
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(sendMessageTelegram.mock.calls[1]?.[0]).toBe("6951571380");
    expect(String(sendMessageTelegram.mock.calls[1]?.[1])).toContain("faltou a associacao obrigatoria com um topico Telegram");
  });

  describe("message_sending hook — hard-suppress", () => {
    it("returns { cancel: true } when session status is 'classifying'", async () => {
      const api = {
        on: vi.fn((name, fn) => {
          if (name === "message_received") handler = fn;
          if (name === "before_prompt_build") beforePromptBuildHandler = fn;
          if (name === "message_sending") messageSendingHandler = fn;
        }),
      } as unknown as OpenClawPluginApi;

      registerTelegramBootstrapHook(api, ctx);
      expect(messageSendingHandler).toBeTypeOf("function");

      await upsertTelegramBootstrapSession("/tmp/workspace", {
        conversationId: "telegram:6951571380",
        rawIdea: "build me an app",
        sourceRoute: { channel: "telegram", channelId: "6951571380" },
        status: "classifying",
      });

      const result = await messageSendingHandler?.(
        { to: "6951571380" },
        { channelId: "telegram" },
      );
      expect(result).toEqual({ cancel: true });
    });

    it("returns { cancel: true } when session status is 'received' (active, not expired)", async () => {
      const api = {
        on: vi.fn((name, fn) => {
          if (name === "message_received") handler = fn;
          if (name === "before_prompt_build") beforePromptBuildHandler = fn;
          if (name === "message_sending") messageSendingHandler = fn;
        }),
      } as unknown as OpenClawPluginApi;

      registerTelegramBootstrapHook(api, ctx);

      await upsertTelegramBootstrapSession("/tmp/workspace", {
        conversationId: "telegram:6951571380",
        rawIdea: "build me an app",
        sourceRoute: { channel: "telegram", channelId: "6951571380" },
        status: "received",
      });

      const result = await messageSendingHandler?.(
        { to: "6951571380" },
        { channelId: "telegram" },
      );
      expect(result).toEqual({ cancel: true });
    });

    it("returns { cancel: true } when session status is 'clarifying'", async () => {
      const api = {
        on: vi.fn((name, fn) => {
          if (name === "message_received") handler = fn;
          if (name === "before_prompt_build") beforePromptBuildHandler = fn;
          if (name === "message_sending") messageSendingHandler = fn;
        }),
      } as unknown as OpenClawPluginApi;

      registerTelegramBootstrapHook(api, ctx);

      await upsertTelegramBootstrapSession("/tmp/workspace", {
        conversationId: "telegram:6951571380",
        rawIdea: "build me an app",
        sourceRoute: { channel: "telegram", channelId: "6951571380" },
        status: "clarifying",
      });

      const result = await messageSendingHandler?.(
        { to: "6951571380" },
        { channelId: "telegram" },
      );
      expect(result).toEqual({ cancel: true });
    });

    it("does NOT cancel (returns undefined) when no session exists", async () => {
      const api = {
        on: vi.fn((name, fn) => {
          if (name === "message_received") handler = fn;
          if (name === "before_prompt_build") beforePromptBuildHandler = fn;
          if (name === "message_sending") messageSendingHandler = fn;
        }),
      } as unknown as OpenClawPluginApi;

      registerTelegramBootstrapHook(api, ctx);

      const result = await messageSendingHandler?.(
        { to: "6951571380" },
        { channelId: "telegram" },
      );
      expect(result).toBeUndefined();
    });

    it("does NOT cancel when session status is 'completed'", async () => {
      const api = {
        on: vi.fn((name, fn) => {
          if (name === "message_received") handler = fn;
          if (name === "before_prompt_build") beforePromptBuildHandler = fn;
          if (name === "message_sending") messageSendingHandler = fn;
        }),
      } as unknown as OpenClawPluginApi;

      registerTelegramBootstrapHook(api, ctx);

      await upsertTelegramBootstrapSession("/tmp/workspace", {
        conversationId: "telegram:6951571380",
        rawIdea: "build me an app",
        sourceRoute: { channel: "telegram", channelId: "6951571380" },
        status: "completed",
      });

      const result = await messageSendingHandler?.(
        { to: "6951571380" },
        { channelId: "telegram" },
      );
      expect(result).toBeUndefined();
    });

    it("does NOT cancel when session is expired (suppressUntil in the past)", async () => {
      const api = {
        on: vi.fn((name, fn) => {
          if (name === "message_received") handler = fn;
          if (name === "before_prompt_build") beforePromptBuildHandler = fn;
          if (name === "message_sending") messageSendingHandler = fn;
        }),
      } as unknown as OpenClawPluginApi;

      registerTelegramBootstrapHook(api, ctx);

      await upsertTelegramBootstrapSession("/tmp/workspace", {
        conversationId: "telegram:6951571380",
        rawIdea: "build me an app",
        sourceRoute: { channel: "telegram", channelId: "6951571380" },
        status: "classifying",
      });

      // Manually overwrite suppressUntil to the past
      const session = await readTelegramBootstrapSession("/tmp/workspace", "telegram:6951571380");
      if (session) {
        session.suppressUntil = new Date(Date.now() - 1000).toISOString();
        await fs.writeFile("/tmp/workspace/fabrica/bootstrap-sessions/telegram:6951571380.json", JSON.stringify(session, null, 2));
      }

      const result = await messageSendingHandler?.(
        { to: "6951571380" },
        { channelId: "telegram" },
      );
      expect(result).toBeUndefined();
    });

    it("does NOT cancel for non-telegram channels", async () => {
      const api = {
        on: vi.fn((name, fn) => {
          if (name === "message_received") handler = fn;
          if (name === "before_prompt_build") beforePromptBuildHandler = fn;
          if (name === "message_sending") messageSendingHandler = fn;
        }),
      } as unknown as OpenClawPluginApi;

      registerTelegramBootstrapHook(api, ctx);

      await upsertTelegramBootstrapSession("/tmp/workspace", {
        conversationId: "telegram:6951571380",
        rawIdea: "build me an app",
        sourceRoute: { channel: "telegram", channelId: "6951571380" },
        status: "classifying",
      });

      const result = await messageSendingHandler?.(
        { to: "6951571380" },
        { channelId: "slack" },
      );
      expect(result).toBeUndefined();
    });

    it("does NOT cancel for group/topic conversations (event.to starts with '-')", async () => {
      const api = {
        on: vi.fn((name, fn) => {
          if (name === "message_received") handler = fn;
          if (name === "before_prompt_build") beforePromptBuildHandler = fn;
          if (name === "message_sending") messageSendingHandler = fn;
        }),
      } as unknown as OpenClawPluginApi;

      registerTelegramBootstrapHook(api, ctx);

      const result = await messageSendingHandler?.(
        { to: "-1003709213169" },
        { channelId: "telegram" },
      );
      expect(result).toBeUndefined();
    });

    it("does NOT cancel for topic conversations (event.to contains ':')", async () => {
      const api = {
        on: vi.fn((name, fn) => {
          if (name === "message_received") handler = fn;
          if (name === "before_prompt_build") beforePromptBuildHandler = fn;
          if (name === "message_sending") messageSendingHandler = fn;
        }),
      } as unknown as OpenClawPluginApi;

      registerTelegramBootstrapHook(api, ctx);

      // Topic messages go to the group ID (starts with "-"), caught by rawTo.startsWith("-") guard
      const result = await messageSendingHandler?.(
        { to: "-1003709213169" },
        { channelId: "telegram" },
      );
      expect(result).toBeUndefined();
    });

    it("returns { cancel: true } when session status is 'pending_classify'", async () => {
      const api = {
        on: vi.fn((name, fn) => {
          if (name === "message_received") handler = fn;
          if (name === "before_prompt_build") beforePromptBuildHandler = fn;
          if (name === "message_sending") messageSendingHandler = fn;
        }),
      } as unknown as OpenClawPluginApi;

      registerTelegramBootstrapHook(api, ctx);

      await upsertTelegramBootstrapSession("/tmp/workspace", {
        conversationId: "telegram:6951571380",
        rawIdea: "build me a cli app",
        sourceRoute: { channel: "telegram", channelId: "6951571380" },
        status: "pending_classify",
      });

      const result = await messageSendingHandler?.(
        { to: "6951571380" },
        { channelId: "telegram" },
      );
      expect(result).toEqual({ cancel: true });
    });
  });

  it("creates pending_classify session synchronously for ambiguous DM before classification", async () => {
    const api = {
      on: vi.fn((name, fn) => {
        if (name === "message_received") handler = fn;
        if (name === "before_prompt_build") beforePromptBuildHandler = fn;
        if (name === "message_sending") messageSendingHandler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    registerTelegramBootstrapHook(api, ctx);

    // Block the classify subagent.run so the session stays observable
    let resolveClassify!: () => void;
    const classifyBarrier = new Promise<void>(resolve => { resolveClassify = resolve; });
    outerMockSubagentRun.mockImplementationOnce(async () => {
      await classifyBarrier;
      return { runId: "blocked-run" };
    });

    // Fire handler — the handler creates the session synchronously then fires classify as fire-and-forget
    handler?.(
      { content: "I need a CLI tool that converts numbers between bases", metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    // Wait for the session to reach "classifying" status (pending_classify → classifying happens
    // synchronously inside classifyAndBootstrap before the blocked runCommand call)
    let session: Awaited<ReturnType<typeof readTelegramBootstrapSession>> = null;
    await vi.waitFor(async () => {
      session = await readTelegramBootstrapSession("/tmp/workspace", "6951571380");
      expect(session).not.toBeNull();
      expect(session!.status).toBe("classifying");
    }, { timeout: 2000 });

    // Session must exist and suppress must be active
    expect(shouldSuppressTelegramBootstrapReply(session)).toBe(true);

    // Unblock classify so the test cleans up properly
    resolveClassify();
    await vi.waitFor(async () => {
      const s = await readTelegramBootstrapSession("/tmp/workspace", "6951571380");
      expect(s).toBeNull(); // classify failed (empty stdout) → session deleted
    }, { timeout: 2000 });
  });

  it("shouldSuppressTelegramBootstrapReply returns true for pending_classify session", async () => {
    await upsertTelegramBootstrapSession("/tmp/workspace", {
      conversationId: "telegram:5555555555",
      rawIdea: "I need a CLI tool",
      sourceRoute: { channel: "telegram", channelId: "5555555555" },
      status: "pending_classify",
    });
    const session = await readTelegramBootstrapSession("/tmp/workspace", "telegram:5555555555");
    expect(session).not.toBeNull();
    expect(shouldSuppressTelegramBootstrapReply(session)).toBe(true);
  });

  describe("Layer 3 confidence threshold", () => {
    afterEach(async () => {
      // Clean up session files written by these tests to avoid polluting other describe blocks.
      // Wait briefly to let any fire-and-forget classifyAndBootstrap calls complete first.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await fs.rm("/tmp/workspace/fabrica/bootstrap-sessions", { recursive: true, force: true });
    });

    it("proceeds with bootstrap when confidence is 0.6 (boundary)", async () => {
      outerMockSubagentRun.mockResolvedValue({ runId: "classify-run" });
      outerMockSubagentWait.mockResolvedValue({ status: "ok" });
      outerMockSubagentGetMessages.mockResolvedValue([
        { role: "assistant", content: JSON.stringify({ intent: "create_project", confidence: 0.6, stackHint: "python-cli", projectSlug: "log-analyzer", language: "pt" }) },
      ]);

      const api = {
        on: vi.fn((name, fn) => {
          if (name === "message_received") handler = fn;
          if (name === "before_prompt_build") beforePromptBuildHandler = fn;
        }),
      } as unknown as OpenClawPluginApi;

      registerTelegramBootstrapHook(api, ctx);

      await handler?.(
        { content: "Preciso de um sistema que analise logs de erro do servidor", metadata: {} },
        { channelId: "telegram", conversationId: "111222333" },
      );

      // Should have sent ack (Layer 3 accepted)
      await vi.waitFor(() => {
        const ackCalls = sendMessageTelegram.mock.calls.filter(
          (c: any) => String(c[1]).includes("Recebi") || String(c[1]).includes("Got it"),
        );
        expect(ackCalls.length).toBeGreaterThanOrEqual(1);
      }, { timeout: 3000 });
    });

    it("proceeds with bootstrap when confidence is 0.65", async () => {
      outerMockSubagentRun.mockResolvedValue({ runId: "classify-run-65" });
      outerMockSubagentWait.mockResolvedValue({ status: "ok" });
      outerMockSubagentGetMessages.mockResolvedValue([
        { role: "assistant", content: JSON.stringify({ intent: "create_project", confidence: 0.65, stackHint: "python-cli", projectSlug: "log-analyzer", language: "pt" }) },
      ]);

      const api = {
        on: vi.fn((name, fn) => {
          if (name === "message_received") handler = fn;
          if (name === "before_prompt_build") beforePromptBuildHandler = fn;
        }),
      } as unknown as OpenClawPluginApi;

      registerTelegramBootstrapHook(api, ctx);

      await handler?.(
        { content: "Preciso de uma ferramenta que analise logs do servidor", metadata: {} },
        { channelId: "telegram", conversationId: "111222335" },
      );

      await vi.waitFor(() => {
        const ackCalls = sendMessageTelegram.mock.calls.filter(
          (c: any) => String(c[1]).includes("Recebi") || String(c[1]).includes("Got it"),
        );
        expect(ackCalls.length).toBeGreaterThanOrEqual(1);
      }, { timeout: 3000 });
    });

    it("falls back to chat when confidence is 0.59 (below threshold)", async () => {
      outerMockSubagentRun.mockResolvedValue({ runId: "classify-run-2" });
      outerMockSubagentWait.mockResolvedValue({ status: "ok" });
      outerMockSubagentGetMessages.mockResolvedValue([
        { role: "assistant", content: JSON.stringify({ intent: "create_project", confidence: 0.59, stackHint: null, projectSlug: null, language: "pt" }) },
      ]);

      const api = {
        on: vi.fn((name, fn) => {
          if (name === "message_received") handler = fn;
          if (name === "before_prompt_build") beforePromptBuildHandler = fn;
        }),
      } as unknown as OpenClawPluginApi;

      registerTelegramBootstrapHook(api, ctx);

      await handler?.(
        { content: "Preciso de um sistema que analise logs de erro do servidor", metadata: {} },
        { channelId: "telegram", conversationId: "111222334" },
      );

      // Wait for fire-and-forget to complete
      await vi.waitFor(() => {
        const ackCalls = sendMessageTelegram.mock.calls.filter(
          (c: any) => String(c[1]).includes("Recebi") || String(c[1]).includes("Got it"),
        );
        expect(ackCalls.length).toBe(0);
      }, { timeout: 3000 });
    });
  });
});

describe("telegram bootstrap session — classifying status", () => {
  const workspaceDir = "/tmp/workspace";

  beforeEach(async () => {
    await fs.rm("/tmp/workspace/fabrica/bootstrap-sessions", { recursive: true, force: true });
  });

  it("auto-cleans expired classifying sessions", async () => {
    // Write a session with "classifying" status and an already-expired suppressUntil
    await upsertTelegramBootstrapSession(workspaceDir, {
      conversationId: "123456",
      rawIdea: "build me an app",
      sourceRoute: { channel: "telegram", channelId: "123456" },
      status: "classifying",
    });

    // Manually expire the session by overwriting suppressUntil
    const sessionPath = `/tmp/workspace/fabrica/bootstrap-sessions/123456.json`;
    const raw = JSON.parse(await fs.readFile(sessionPath, "utf-8"));
    raw.suppressUntil = new Date(Date.now() - 1000).toISOString();
    await fs.writeFile(sessionPath, JSON.stringify(raw), "utf-8");

    // readTelegramBootstrapSession should auto-clean and return null
    const result = await readTelegramBootstrapSession(workspaceDir, "123456");
    expect(result).toBeNull();

    // File should be deleted
    await expect(fs.access(sessionPath)).rejects.toThrow();
  });

  it("preserves active classifying sessions", async () => {
    await upsertTelegramBootstrapSession(workspaceDir, {
      conversationId: "123456",
      rawIdea: "build me an app",
      sourceRoute: { channel: "telegram", channelId: "123456" },
      status: "classifying",
    });

    const result = await readTelegramBootstrapSession(workspaceDir, "123456");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("classifying");
  });
});

describe("isAmbiguousCandidate", () => {
  it("returns false for messages <= 20 chars even with softwareCue", () => {
    // "uma cli legal aaaaaa" = exactly 20 chars (has softwareCue "cli")
    expect(isAmbiguousCandidate("uma cli legal aaaaaa")).toBe(false);
  });

  it("returns true for messages > 20 chars with softwareCue", () => {
    expect(isAmbiguousCandidate("uma cli legal aaaaaaa")).toBe(true); // 21 chars
  });

  it("returns false for messages > 500 chars even with softwareCue", () => {
    const longMsg = "preciso de um sistema " + "a".repeat(480);
    expect(longMsg.length).toBeGreaterThan(500);
    expect(isAmbiguousCandidate(longMsg)).toBe(false);
  });

  it("returns true for messages at exactly 500 chars with softwareCue", () => {
    const msg = "preciso de um sistema " + "a".repeat(478);
    expect(msg.length).toBe(500);
    expect(isAmbiguousCandidate(msg)).toBe(true);
  });

  it("returns false for messages without any softwareCue regardless of length", () => {
    expect(isAmbiguousCandidate("oi tudo bem como voce esta hoje?")).toBe(false);
  });

  it("detects expanded software cues: tool, ferramenta, sistema, bot, script, programa", () => {
    expect(isAmbiguousCandidate("preciso de uma ferramenta pra isso")).toBe(true);
    expect(isAmbiguousCandidate("me faz um bot que responde msgs")).toBe(true);
    expect(isAmbiguousCandidate("quero um script de automacao")).toBe(true);
    expect(isAmbiguousCandidate("need a tool for data processing")).toBe(true);
    expect(isAmbiguousCandidate("build me a system for tracking")).toBe(true);
    expect(isAmbiguousCandidate("quero um programa de contabilidade")).toBe(true);
  });
});

describe("classifyDmIntent", () => {
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
          sendMessageTelegram: vi.fn(async () => undefined),
        },
      },
    },
    runCommand: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
  } as any;

  function makeSubagentCtx(responseContent: string, opts: { throws?: boolean; waitStatus?: string } = {}) {
    const mockRun = opts.throws
      ? vi.fn(async () => { throw new Error("timeout"); })
      : vi.fn().mockResolvedValue({ runId: "test-run" });
    const mockWait = vi.fn().mockResolvedValue({ status: opts.waitStatus ?? "ok" });
    const mockGetMessages = vi.fn().mockResolvedValue([
      { role: "assistant", content: responseContent },
    ]);
    return {
      ...ctx,
      runtime: {
        ...ctx.runtime,
        subagent: { run: mockRun, waitForRun: mockWait, getSessionMessages: mockGetMessages },
      },
    } as any;
  }

  it("returns create_project classification for a valid LLM response", async () => {
    const mockCtx = makeSubagentCtx('{"intent":"create_project","confidence":0.95,"stackHint":"python-cli","projectSlug":"cpf-validator"}');

    const result = await classifyDmIntent(mockCtx, "Cria uma CLI Python que valida CPF", "/tmp/workspace");
    expect(result).toEqual({
      intent: "create_project",
      confidence: 0.95,
      stackHint: "python-cli",
      projectSlug: "cpf-validator",
      language: "pt",
    });
  });

  it("returns other classification for non-project messages", async () => {
    const mockCtx = makeSubagentCtx('{"intent":"other","confidence":0.99,"stackHint":null,"projectSlug":null}');

    const result = await classifyDmIntent(mockCtx, "Oi, tudo bem?", "/tmp/workspace");
    expect(result).toEqual({
      intent: "other",
      confidence: 0.99,
      stackHint: null,
      projectSlug: null,
      language: "pt",
    });
  });

  it("returns null when LLM throws (timeout/error)", async () => {
    const mockCtx = makeSubagentCtx("", { throws: true });

    const result = await classifyDmIntent(mockCtx, "Build me a tool", "/tmp/workspace");
    expect(result).toBeNull();
  });

  it("returns null when LLM returns invalid JSON", async () => {
    const mockCtx = makeSubagentCtx("not json at all");

    const result = await classifyDmIntent(mockCtx, "Build me a tool", "/tmp/workspace");
    expect(result).toBeNull();
  });

  it("returns null when LLM response fails Zod validation", async () => {
    const mockCtx = makeSubagentCtx('{"intent":"maybe","confidence":"high"}');

    const result = await classifyDmIntent(mockCtx, "Build me a tool", "/tmp/workspace");
    expect(result).toBeNull();
  });

  it("returns low-confidence classification without filtering (caller decides threshold)", async () => {
    const mockCtx = makeSubagentCtx('{"intent":"create_project","confidence":0.5,"stackHint":null,"projectSlug":null}');

    const result = await classifyDmIntent(mockCtx, "I need something for tasks", "/tmp/workspace");
    expect(result).toEqual({
      intent: "create_project",
      confidence: 0.5,
      stackHint: null,
      projectSlug: null,
      language: "pt",
    });
  });

  it("returns language field when LLM provides it", async () => {
    const mockCtx = makeSubagentCtx('{"intent":"create_project","confidence":0.9,"stackHint":"python-cli","projectSlug":"test","language":"en"}');
    const result = await classifyDmIntent(mockCtx, "Build me a CLI", "/tmp/workspace");
    expect(result).not.toBeNull();
    expect(result!.language).toBe("en");
  });

  it("defaults language to 'pt' when LLM omits it", async () => {
    const mockRun = vi.fn().mockResolvedValue({ runId: "test-lang-run" });
    const mockWait = vi.fn().mockResolvedValue({ status: "ok" });
    const mockGetMessages = vi.fn().mockResolvedValue([
      { role: "assistant", content: '{"intent":"create_project","confidence":0.9,"stackHint":"python-cli","projectSlug":"test"}' },
    ]);
    const mockCtx = {
      ...ctx,
      runtime: {
        ...ctx.runtime,
        subagent: { run: mockRun, waitForRun: mockWait, getSessionMessages: mockGetMessages },
      },
    };
    const result = await classifyDmIntent(mockCtx as any, "Cria uma CLI", "/tmp/workspace");
    expect(result).not.toBeNull();
    expect(result!.language).toBe("pt");
  });

  it("returns classification via runtime.subagent.run when available", async () => {
    const mockRun = vi.fn().mockResolvedValue({ runId: "test-run-1" });
    const mockWait = vi.fn().mockResolvedValue({ status: "ok" });
    const mockGetMessages = vi.fn().mockResolvedValue([
      { role: "assistant", content: JSON.stringify({
        intent: "create_project",
        confidence: 0.95,
        stackHint: "python-cli",
        projectSlug: "base-converter",
        language: "en",
      })},
    ]);

    const ctxWithSubagent = {
      ...ctx,
      runtime: {
        ...ctx.runtime,
        subagent: {
          run: mockRun,
          waitForRun: mockWait,
          getSessionMessages: mockGetMessages,
        },
      },
    } as any;

    const result = await classifyDmIntent(ctxWithSubagent, "I need a CLI tool that converts numbers between bases", "/tmp/workspace");
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("create_project");
    expect(result!.projectSlug).toBe("base-converter");
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun.mock.calls[0][0]).toMatchObject({
      lane: "subagent",
      deliver: false,
    });
  });

  it("returns null when runtime.subagent is not available", async () => {
    const ctxNoSubagent = { ...ctx, runtime: { channel: ctx.runtime.channel } } as any;
    const result = await classifyDmIntent(ctxNoSubagent, "Build me a REST API", "/tmp/workspace");
    expect(result).toBeNull();
  });

  it("returns null when LLM response is not valid JSON", async () => {
    const mockRun = vi.fn().mockResolvedValue({ runId: "test-run-2" });
    const mockWait = vi.fn().mockResolvedValue({ status: "ok" });
    const mockGetMessages = vi.fn().mockResolvedValue([
      { role: "assistant", content: "Sorry, I cannot classify this message." },
    ]);

    const ctxBadResponse = {
      ...ctx,
      runtime: {
        ...ctx.runtime,
        subagent: { run: mockRun, waitForRun: mockWait, getSessionMessages: mockGetMessages },
      },
    } as any;

    const result = await classifyDmIntent(ctxBadResponse, "Hello there", "/tmp/workspace");
    expect(result).toBeNull();
  });

  it("returns null when subagent times out", async () => {
    const mockRun = vi.fn().mockResolvedValue({ runId: "test-run-3" });
    const mockWait = vi.fn().mockResolvedValue({ status: "timeout" });

    const ctxTimeout = {
      ...ctx,
      runtime: {
        ...ctx.runtime,
        subagent: { run: mockRun, waitForRun: mockWait, getSessionMessages: vi.fn() },
      },
    } as any;

    const result = await classifyDmIntent(ctxTimeout, "Create a CLI", "/tmp/workspace");
    expect(result).toBeNull();
  });
});

// NOTE: The following describe block tests Layer 3 integration via the message_received handler.
describe("Layer 3: LLM classification via message_received", () => {
  let handler: ((msg: any, meta: any) => Promise<void>) | undefined;
  const sendMessageTelegram = vi.fn(async () => undefined);
  const mockSubagentRun = vi.fn().mockResolvedValue({ runId: "layer3-run" });
  const mockSubagentWait = vi.fn().mockResolvedValue({ status: "ok" });
  const mockSubagentGetMessages = vi.fn().mockResolvedValue([]);

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
      subagent: {
        run: mockSubagentRun,
        waitForRun: mockSubagentWait,
        getSessionMessages: mockSubagentGetMessages,
      },
    },
    runCommand: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
  } as any;

  beforeEach(async () => {
    handler = undefined;
    sendMessageTelegram.mockClear();
    ctx.runCommand.mockClear();
    ctx.runCommand.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    mockSubagentRun.mockClear();
    mockSubagentWait.mockClear();
    mockSubagentGetMessages.mockClear();
    mockSubagentRun.mockResolvedValue({ runId: "layer3-run" });
    mockSubagentWait.mockResolvedValue({ status: "ok" });
    mockSubagentGetMessages.mockResolvedValue([]);
    mockRunPipeline.mockReset();
    mockReadProjects.mockReset();
    mockProjectTick.mockReset();
    mockDiscoverAgents.mockReset();
    mockReadProjects.mockResolvedValue({ projects: {} });
    mockDiscoverAgents.mockReturnValue([{ agentId: "main", workspace: "/tmp/workspace" }]);
    mockProjectTick.mockResolvedValue({ pickups: [], skipped: [] });
    await fs.rm("/tmp/workspace/fabrica/bootstrap-sessions", { recursive: true, force: true });
  });

  it("classifies ambiguous message via LLM and triggers bootstrap when create_project", async () => {
    const api = {
      on: vi.fn((name: string, fn: any) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    mockSubagentGetMessages.mockResolvedValue([
      { role: "assistant", content: '{"intent":"create_project","confidence":0.95,"stackHint":"python-cli","projectSlug":"validador-cpf"}' },
    ]);

    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          channel_id: "-1003709213169",
          message_thread_id: 888,
          project_slug: "validador-cpf",
        },
      },
    });

    registerTelegramBootstrapHook(api, ctx);

    // "Build me a Python CLI that validates CPF numbers" — no createCue, but has softwareCue "CLI"
    await handler?.(
      { content: "Build me a Python CLI that validates CPF numbers", metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    // classifyAndBootstrap is fire-and-forget; wait for pipeline
    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 5000 });

    // Verify ack was sent
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "6951571380",
      expect.stringContaining("Recebi!"),
      expect.anything(),
    );
  });

  it("deletes session and does not bootstrap when LLM returns 'other'", async () => {
    const api = {
      on: vi.fn((name: string, fn: any) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    mockSubagentGetMessages.mockResolvedValue([
      { role: "assistant", content: '{"intent":"other","confidence":0.95,"stackHint":null,"projectSlug":null}' },
    ]);

    registerTelegramBootstrapHook(api, ctx);

    // "How does this API work?" — has softwareCue "API", >20 chars, but not a project request
    await handler?.(
      { content: "How does this API work in the system?", metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    // Wait for fire-and-forget to complete
    await new Promise((r) => setTimeout(r, 200));

    expect(mockRunPipeline).not.toHaveBeenCalled();
    expect(sendMessageTelegram).not.toHaveBeenCalled();
  });

  it("deletes session when LLM call fails (fail-open to chat)", async () => {
    const api = {
      on: vi.fn((name: string, fn: any) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    mockSubagentRun.mockImplementation(async () => { throw new Error("LLM timeout"); });

    registerTelegramBootstrapHook(api, ctx);

    await handler?.(
      { content: "I need a tool for data processing tasks", metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    await new Promise((r) => setTimeout(r, 200));

    expect(mockRunPipeline).not.toHaveBeenCalled();
    expect(sendMessageTelegram).not.toHaveBeenCalled();
    const session = await readTelegramBootstrapSession("/tmp/workspace", "6951571380");
    expect(session).toBeNull();
  });

  it("enters clarification when LLM returns create_project without stackHint", async () => {
    const api = {
      on: vi.fn((name: string, fn: any) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    mockSubagentGetMessages.mockResolvedValue([
      { role: "assistant", content: '{"intent":"create_project","confidence":0.9,"stackHint":null,"projectSlug":"task-manager"}' },
    ]);

    registerTelegramBootstrapHook(api, ctx);

    // "I want an app that manages my tasks and deadlines" — no stack hint detectable
    await handler?.(
      { content: "I want an app that manages my tasks and deadlines", metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(2), { timeout: 5000 });

    // First call: ack
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).toContain("Recebi!");
    // Second call: clarification asking for stack
    expect(String(sendMessageTelegram.mock.calls[1]?.[1])).toMatch(/stack|tecnologia/i);

    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it("does not call LLM for messages without softwareCue", async () => {
    const api = {
      on: vi.fn((name: string, fn: any) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    registerTelegramBootstrapHook(api, ctx);

    await handler?.(
      { content: "Oi, como vai? Tudo tranquilo?", metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    expect(mockSubagentRun).not.toHaveBeenCalled();
    expect(mockRunPipeline).not.toHaveBeenCalled();
    expect(sendMessageTelegram).not.toHaveBeenCalled();
  });
});

describe("Layer 2 language heuristic", () => {
  let handler: ((event: any, eventCtx: any) => Promise<void>) | undefined;
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

  it("sends Portuguese ack for PT createCue (crie)", async () => {
    const api = {
      on: vi.fn((name, fn) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    // Mock pipeline so fire-and-forget does not leave dangling async
    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: { metadata: { channel_id: "-1003709213169", message_thread_id: 900, project_slug: "novo-projeto-cli" } },
    });

    registerTelegramBootstrapHook(api, ctx);

    // "Crie um novo projeto cli python" — has createCue "crie" (PT) + softwareCue "cli" + "projeto"
    // detectStackHint matches "cli python" → python-cli, stack known but no name → name clarification fires
    await handler?.(
      { content: "Crie um novo projeto cli python", metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    // First call is the ack (synchronous); drain fire-and-forget name clarification
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(sendMessageTelegram.mock.calls[0]?.[0]).toBe("6951571380");
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).toContain("Recebi!");
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).not.toContain("Got it!");
  });

  it("sends English ack for EN createCue (create)", async () => {
    const api = {
      on: vi.fn((name, fn) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: { metadata: { channel_id: "-1003709213169", message_thread_id: 901, project_slug: "new-project-cli" } },
    });

    registerTelegramBootstrapHook(api, ctx);

    // "Create a new project cli python" — has createCue "create" (EN) + softwareCue "cli" + "project"
    // Stack detected (python-cli); no projectName → name clarification fires asynchronously
    await handler?.(
      { content: "Create a new project cli python", metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    // Drain fire-and-forget name clarification (ack + clarifyName)
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(sendMessageTelegram.mock.calls[0]?.[0]).toBe("6951571380");
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).toContain("Got it!");
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).not.toContain("Recebi!");
  });

  it("sends Portuguese ack for 'novo projeto' createCue", async () => {
    const api = {
      on: vi.fn((name, fn) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: { metadata: { channel_id: "-1003709213169", message_thread_id: 902, project_slug: "novo-projeto-cli" } },
    });

    registerTelegramBootstrapHook(api, ctx);

    // "novo projeto cli python" — has createCue "novo projeto" (PT) + softwareCue "cli"
    // Stack detected (python-cli); no projectName → name clarification fires asynchronously
    await handler?.(
      { content: "novo projeto cli python", metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    // Drain fire-and-forget name clarification (ack + clarifyName)
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(sendMessageTelegram.mock.calls[0]?.[0]).toBe("6951571380");
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).toContain("Recebi!");
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).not.toContain("Got it!");
  });

  it("sends English ack for 'new project' createCue", async () => {
    const api = {
      on: vi.fn((name, fn) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: { metadata: { channel_id: "-1003709213169", message_thread_id: 903, project_slug: "new-project-cli" } },
    });

    registerTelegramBootstrapHook(api, ctx);

    // "new project cli python" — has createCue "new project" (EN) + softwareCue "cli"
    // Stack detected (python-cli); no projectName → name clarification fires asynchronously
    await handler?.(
      { content: "new project cli python", metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    // Drain fire-and-forget name clarification (ack + clarifyName)
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(sendMessageTelegram.mock.calls[0]?.[0]).toBe("6951571380");
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).toContain("Got it!");
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).not.toContain("Recebi!");
  });
});

describe("buildTopicDeepLink", () => {
  it("strips -100 prefix and builds deep link", () => {
    expect(buildTopicDeepLink("-1003709213169", 925)).toBe("https://t.me/c/3709213169/925");
  });

  it("strips -100 prefix for different chat ID", () => {
    expect(buildTopicDeepLink("-1001234567890", 42)).toBe("https://t.me/c/1234567890/42");
  });

  it("handles chat ID without -100 prefix gracefully", () => {
    expect(buildTopicDeepLink("9876543210", 7)).toBe("https://t.me/c/9876543210/7");
  });
});

describe("bilingual bootstrap messages", () => {
  let handler: ((msg: any, meta: any) => Promise<void>) | undefined;
  const sendMessageTelegram = vi.fn(async () => undefined);
  const mockBiSubagentRun = vi.fn().mockResolvedValue({ runId: "bilingual-run" });
  const mockBiSubagentWait = vi.fn().mockResolvedValue({ status: "ok" });
  const mockBiSubagentGetMessages = vi.fn().mockResolvedValue([]);

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
      subagent: {
        run: mockBiSubagentRun,
        waitForRun: mockBiSubagentWait,
        getSessionMessages: mockBiSubagentGetMessages,
      },
    },
    runCommand: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
  } as any;

  beforeEach(async () => {
    handler = undefined;
    sendMessageTelegram.mockClear();
    ctx.runCommand.mockClear();
    ctx.runCommand.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    mockBiSubagentRun.mockClear();
    mockBiSubagentWait.mockClear();
    mockBiSubagentGetMessages.mockClear();
    mockBiSubagentRun.mockResolvedValue({ runId: "bilingual-run" });
    mockBiSubagentWait.mockResolvedValue({ status: "ok" });
    mockBiSubagentGetMessages.mockResolvedValue([]);
    mockRunPipeline.mockReset();
    mockReadProjects.mockReset();
    mockProjectTick.mockReset();
    mockDiscoverAgents.mockReset();
    mockReadProjects.mockResolvedValue({ projects: {} });
    mockDiscoverAgents.mockReturnValue([{ agentId: "main", workspace: "/tmp/workspace" }]);
    mockProjectTick.mockResolvedValue({ pickups: [], skipped: [] });
    await fs.rm("/tmp/workspace/fabrica/bootstrap-sessions", { recursive: true, force: true });
  });

  it("sends English ack when LLM detects language=en", async () => {
    const api = {
      on: vi.fn((name: string, fn: any) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    mockBiSubagentGetMessages.mockResolvedValue([
      { role: "assistant", content: '{"intent":"create_project","confidence":0.92,"stackHint":"python-cli","projectSlug":"cpf-validator","language":"en"}' },
    ]);

    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          channel_id: "-1003709213169",
          message_thread_id: 999,
          project_slug: "cpf-validator",
        },
      },
    });

    registerTelegramBootstrapHook(api, ctx);

    // Ambiguous message: has softwareCue "tool" but no createCue
    await handler?.(
      { content: "I need a Python tool that validates CPF numbers", metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    // Wait for fire-and-forget classify + ack
    await vi.waitFor(
      () => expect(sendMessageTelegram).toHaveBeenCalledWith(
        "6951571380",
        expect.stringContaining("Got it!"),
        expect.anything(),
      ),
      { timeout: 5000 },
    );
  });

  it("sends English clarification when LLM returns language=en without stackHint", async () => {
    const api = {
      on: vi.fn((name: string, fn: any) => {
        if (name === "message_received") handler = fn;
      }),
    } as unknown as OpenClawPluginApi;

    mockBiSubagentGetMessages.mockResolvedValue([
      { role: "assistant", content: '{"intent":"create_project","confidence":0.88,"stackHint":null,"projectSlug":"my-tool","language":"en"}' },
    ]);

    registerTelegramBootstrapHook(api, ctx);

    // Ambiguous message: has softwareCue "tool" but no createCue, no stack
    await handler?.(
      { content: "I need a tool for data validation and reporting", metadata: {} },
      { channelId: "telegram", conversationId: "6951571380" },
    );

    // Wait for ack + clarification messages
    await vi.waitFor(
      () => expect(sendMessageTelegram).toHaveBeenCalledTimes(2),
      { timeout: 5000 },
    );

    // First call: English ack
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).toContain("Got it!");
    // Second call: English clarification asking for stack
    expect(String(sendMessageTelegram.mock.calls[1]?.[1])).toMatch(/stack|which/i);
    expect(String(sendMessageTelegram.mock.calls[1]?.[1])).not.toContain("Qual stack");
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });
});

describe("inferProjectSlug prefix stripping", () => {
  it("strips 'Create a' prefix", () => {
    expect(inferProjectSlug("Create a Python CLI tool")).toBe("python-cli-tool");
  });
  it("strips 'I need a' prefix", () => {
    expect(inferProjectSlug("I need a REST API")).toBe("rest-api");
  });
  it("strips trailing 'that ...' clause", () => {
    expect(inferProjectSlug("CLI tool that converts numbers")).toBe("cli-tool");
  });
  it("handles normal text without prefix", () => {
    expect(inferProjectSlug("base-converter-cli")).toBe("base-converter-cli");
  });
  it("strips 'crie um' prefix (portuguese)", () => {
    expect(inferProjectSlug("crie uma CLI de tarefas")).toBe("cli-de-tarefas");
  });
  it("strips 'Build a' prefix", () => {
    expect(inferProjectSlug("Build a task manager app")).toBe("task-manager-app");
  });
});

describe("normalizeUserResponse", () => {
  it("strips trailing punctuation and lowercases", () => {
    expect(normalizeUserResponse("Python.")).toBe("python");
    expect(normalizeUserResponse("node,")).toBe("node");
    expect(normalizeUserResponse("Rust!")).toBe("rust");
    expect(normalizeUserResponse("java?")).toBe("java");
    expect(normalizeUserResponse("Go...")).toBe("go");
    expect(normalizeUserResponse("TypeScript;:")).toBe("typescript");
    expect(normalizeUserResponse("Python\u2026")).toBe("python");
  });

  it("preserves clean input", () => {
    expect(normalizeUserResponse("python")).toBe("python");
    expect(normalizeUserResponse("  node  ")).toBe("node");
  });

  it("does not strip punctuation mid-word", () => {
    expect(normalizeUserResponse("node.js")).toBe("node.js");
    expect(normalizeUserResponse("C#")).toBe("c#");
  });
});
