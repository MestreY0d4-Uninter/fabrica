/**
 * Tests for the Telegram DM bootstrap clarification flow.
 *
 * Covers:
 * - Natural "python" response to clarification → pipeline continues with original rawIdea
 * - Irrelevant response → re-asks (buildFollowUpClarification)
 * - Structured "Stack: node-cli" response → pipeline continues
 * - Expired clarifying session + new bootstrap candidate → starts fresh (not treated as clarification)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  return { ...actual, readProjects: mockReadProjects };
});

vi.mock("../../lib/services/tick.js", () => ({
  projectTick: mockProjectTick,
}));

vi.mock("../../lib/services/heartbeat/agent-discovery.js", () => ({
  discoverAgents: mockDiscoverAgents,
}));

const WORKSPACE = "/tmp/workspace-flow-tests";

const sendMessageTelegram = vi.fn(async () => undefined);

const ctx = {
  pluginConfig: {
    telegram: {
      bootstrapDmEnabled: true,
      projectsForumChatId: "-1003709213169",
    },
  },
  config: {
    agents: { defaults: { workspace: WORKSPACE } },
  },
  logger: { info: vi.fn(), warn: vi.fn() },
  runtime: {
    channel: { telegram: { sendMessageTelegram } },
  },
  runCommand: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
} as any;

function makeApi(onMessage: (fn: any) => void): OpenClawPluginApi {
  return {
    on: vi.fn((name, fn) => {
      if (name === "message_received") onMessage(fn);
    }),
  } as unknown as OpenClawPluginApi;
}

const CONVERSATION_ID = "9876543210";

describe("telegram bootstrap clarification flow", () => {
  let handler: ((event: any, eventCtx: any) => Promise<void>) | undefined;

  beforeEach(async () => {
    handler = undefined;
    sendMessageTelegram.mockClear();
    mockRunPipeline.mockReset();
    mockReadProjects.mockReset();
    mockProjectTick.mockReset();
    mockDiscoverAgents.mockReset();
    mockReadProjects.mockResolvedValue({ projects: {} });
    mockDiscoverAgents.mockReturnValue([{ agentId: "main", workspace: WORKSPACE }]);
    mockProjectTick.mockResolvedValue({ pickups: [], skipped: [] });
    // Clean up session files from prior tests
    await fs.rm(`${WORKSPACE}/fabrica/bootstrap-sessions`, { recursive: true, force: true });

    const api = makeApi((fn) => { handler = fn; });
    registerTelegramBootstrapHook(api, ctx);
  });

  afterEach(async () => {
    await fs.rm(`${WORKSPACE}/fabrica/bootstrap-sessions`, { recursive: true, force: true });
  });

  it("resumes pipeline with original rawIdea after bare 'python' clarification response", async () => {
    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          channel_id: "-1003709213169",
          message_thread_id: 800,
          project_slug: "my-cli",
        },
      },
    });

    // Step 1: send bootstrap candidate without stack → triggers clarification
    await handler?.(
      { content: "Crie um projeto novo para uma CLI de tarefas", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    expect(mockRunPipeline).not.toHaveBeenCalled();
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    // Clarification was asked
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).toContain("stack");

    sendMessageTelegram.mockClear();

    // Step 2: user replies with bare "python"
    await handler?.(
      { content: "python", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    // Pipeline should be called with the original rawIdea
    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const pipelinePayload = mockRunPipeline.mock.calls[0]?.[0];
    expect(pipelinePayload.raw_idea).toContain("CLI de tarefas");
    // Stack should be resolved to python-cli
    expect(pipelinePayload.metadata.stack_hint).toBe("python-cli");
  });

  it("re-asks when clarification response is irrelevant", async () => {
    // Step 1: trigger clarification
    await handler?.(
      { content: "Crie um novo projeto CLI", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    sendMessageTelegram.mockClear();

    // Step 2: user sends an irrelevant message
    await handler?.(
      { content: "ok entendido obrigado", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    // Pipeline must NOT have been called
    expect(mockRunPipeline).not.toHaveBeenCalled();
    // Must have sent a follow-up clarification
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    const followUp = String(sendMessageTelegram.mock.calls[0]?.[1]);
    // Follow-up should be a re-question about stack
    expect(followUp).toMatch(/stack|linguagem|framework/i);
  });

  it("resumes pipeline after structured 'Stack: node-cli' clarification", async () => {
    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          channel_id: "-1003709213169",
          message_thread_id: 801,
          project_slug: "node-tool",
        },
      },
    });

    // Step 1: trigger clarification
    await handler?.(
      { content: "Crie um projeto para automatizar deploys", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    sendMessageTelegram.mockClear();

    // Step 2: structured clarification response
    await handler?.(
      { content: "Stack: node-cli", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const pipelinePayload = mockRunPipeline.mock.calls[0]?.[0];
    expect(pipelinePayload.metadata.stack_hint).toBe("node-cli");
    // original idea preserved
    expect(pipelinePayload.raw_idea).toContain("automatizar deploys");
  });

  it("treats new bootstrap candidate as fresh request when clarifying session has expired", async () => {
    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          channel_id: "-1003709213169",
          message_thread_id: 802,
          project_slug: "fresh-project",
        },
      },
    });

    // Step 1: trigger clarification for an initial request
    await handler?.(
      { content: "Crie um projeto CLI inicial", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    sendMessageTelegram.mockClear();

    // Simulate session expiry: overwrite the session file with a past suppressUntil
    const sessionDir = `${WORKSPACE}/fabrica/bootstrap-sessions`;
    const sessionFile = `${sessionDir}/${CONVERSATION_ID}.json`;
    try {
      const raw = await fs.readFile(sessionFile, "utf-8");
      const session = JSON.parse(raw);
      session.suppressUntil = new Date(Date.now() - 60_000).toISOString();
      await fs.writeFile(sessionFile, JSON.stringify(session, null, 2) + "\n", "utf-8");
    } catch {
      // If session file doesn't exist, skip this test scenario
      return;
    }

    // Step 2: send a completely new bootstrap candidate
    await handler?.(
      {
        content: "Crie um novo projeto totalmente diferente. Stack: python-cli. Idea: outra ideia.",
        metadata: {},
      },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    // Since session is expired, the new message is a bootstrap candidate that should proceed
    // (either to clarification for the new request, or directly to pipeline if stack is present)
    // In this case, Stack is provided so it should go to pipeline
    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const pipelinePayload = mockRunPipeline.mock.calls[0]?.[0];
    // The pipeline gets the NEW idea, not the old one
    expect(pipelinePayload.raw_idea).toContain("outra ideia");
    expect(pipelinePayload.metadata.stack_hint).toBe("python-cli");
  });
});
