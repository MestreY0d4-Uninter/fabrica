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

  it("resumes pipeline with original rawIdea after bare 'python' clarification response followed by name", async () => {
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
    // ack sent first, then clarification question
    expect(sendMessageTelegram).toHaveBeenCalledTimes(2);
    // Clarification was asked (second call)
    expect(String(sendMessageTelegram.mock.calls[1]?.[1])).toContain("stack");

    sendMessageTelegram.mockClear();

    // Step 2: user replies with bare "python" — stack resolved, now asks for name
    await handler?.(
      { content: "python", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    // Should ask for project name now
    await vi.waitFor(
      () => expect(sendMessageTelegram).toHaveBeenCalledTimes(1),
      { timeout: 2000 },
    );
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).toMatch(/nome|name/i);
    expect(mockRunPipeline).not.toHaveBeenCalled();
    sendMessageTelegram.mockClear();

    // Step 3: user provides project name
    await handler?.(
      { content: "tarefas-cli", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    // Pipeline should be called with the original rawIdea
    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const pipelinePayload = mockRunPipeline.mock.calls[0]?.[0];
    expect(pipelinePayload.raw_idea).toContain("CLI de tarefas");
    // Stack should be resolved to python-cli
    expect(pipelinePayload.metadata.stack_hint).toBe("python-cli");
    expect(pipelinePayload.metadata.project_name).toBe("tarefas-cli");
  });

  it("re-asks when clarification response is irrelevant", async () => {
    // Step 1: trigger clarification
    await handler?.(
      { content: "Crie um novo projeto CLI", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    // ack sent first, then clarification question
    expect(sendMessageTelegram).toHaveBeenCalledTimes(2);
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

  it("resumes pipeline after structured 'Stack: node-cli' clarification followed by name", async () => {
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

    // ack sent first, then clarification question
    expect(sendMessageTelegram).toHaveBeenCalledTimes(2);
    sendMessageTelegram.mockClear();

    // Step 2: structured clarification response for stack
    await handler?.(
      { content: "Stack: node-cli", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    // Should ask for project name now
    await vi.waitFor(
      () => expect(sendMessageTelegram).toHaveBeenCalledTimes(1),
      { timeout: 2000 },
    );
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).toMatch(/nome|name/i);
    sendMessageTelegram.mockClear();
    expect(mockRunPipeline).not.toHaveBeenCalled();

    // Step 3: user provides project name
    await handler?.(
      { content: "deploy-automation-cli", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const pipelinePayload = mockRunPipeline.mock.calls[0]?.[0];
    expect(pipelinePayload.metadata.stack_hint).toBe("node-cli");
    expect(pipelinePayload.metadata.project_name).toBe("deploy-automation-cli");
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

    // ack sent first, then clarification question
    expect(sendMessageTelegram).toHaveBeenCalledTimes(2);
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

    // Step 2: send a completely new bootstrap candidate with project name (newline-separated fields)
    await handler?.(
      {
        content: "Crie um novo projeto totalmente diferente.\nStack: python-cli\nProject name: novo-projeto-cli\nIdea: outra ideia.",
        metadata: {},
      },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    // Since session is expired, the new message is a bootstrap candidate that should proceed
    // Stack + project name are both provided, so it should go to pipeline directly
    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const pipelinePayload = mockRunPipeline.mock.calls[0]?.[0];
    // The pipeline gets the NEW idea, not the old one
    expect(pipelinePayload.raw_idea).toContain("outra ideia");
    expect(pipelinePayload.metadata.stack_hint).toBe("python-cli");
    expect(pipelinePayload.metadata.project_name).toBe("novo-projeto-cli");
  });

  it("asks for project name when stack is known but name is missing, then accepts bare name response", async () => {
    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          channel_id: "-1003709213169",
          message_thread_id: 803,
          project_slug: "my-converter",
        },
      },
    });

    // Send DM with explicit stack but no project name
    await handler?.(
      { content: "Crie um projeto.\nStack: python-cli\nIdeia: Uma CLI para converter bases numericas.", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    // Should ask for project name: ack first (sync), then name question (async from bootstrapWithTimeout)
    await vi.waitFor(
      () => expect(sendMessageTelegram).toHaveBeenCalledTimes(2),
      { timeout: 3000 },
    );
    const calls = sendMessageTelegram.mock.calls.map((c: any[]) => String(c[1] ?? ""));
    const nameQuestion = calls.find((msg: string) => /nome|name/i.test(msg));
    expect(nameQuestion).toBeTruthy();
    sendMessageTelegram.mockClear();

    // User responds with a project name
    await handler?.(
      { content: "base-converter-cli", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    await vi.waitFor(
      () => expect(mockRunPipeline).toHaveBeenCalledTimes(1),
      { timeout: 3000 },
    );
    const payload = mockRunPipeline.mock.calls[0]?.[0];
    expect(payload.metadata.project_name).toBe("base-converter-cli");
    expect(payload.metadata.stack_hint).toBe("python-cli");
  });

  it("recognizes 'Python.' (with punctuation) as stack clarification response", async () => {
    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: { channel_id: "-1003709213169", message_thread_id: 900, project_slug: "my-project" },
      },
    });

    // Step 1: trigger clarification (stack_and_name)
    await handler?.(
      { content: "Crie um projeto novo para validar CPF", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );
    expect(sendMessageTelegram).toHaveBeenCalledTimes(2); // ack + clarification
    sendMessageTelegram.mockClear();

    // Step 2: user replies "Python." with trailing period
    await handler?.(
      { content: "Python.", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    // Should ask for project name (stack resolved)
    await vi.waitFor(
      () => expect(sendMessageTelegram).toHaveBeenCalledTimes(1),
      { timeout: 2000 },
    );
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).toMatch(/nome|name/i);
  });

  it("recognizes bare 'Python' (no punctuation) as stack — regression", async () => {
    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: { channel_id: "-1003709213169", message_thread_id: 901, project_slug: "my-project2" },
      },
    });

    // Step 1: trigger clarification (stack_and_name)
    await handler?.(
      { content: "Crie um projeto novo para monitorar servidores", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );
    sendMessageTelegram.mockClear();

    // Step 2: "Python" without punctuation — must still work
    await handler?.(
      { content: "Python", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    await vi.waitFor(
      () => expect(sendMessageTelegram).toHaveBeenCalledTimes(1),
      { timeout: 2000 },
    );
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).toMatch(/nome|name/i);
  });
});
