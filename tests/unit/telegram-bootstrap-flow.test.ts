/**
 * Tests for the Telegram DM bootstrap clarification flow.
 *
 * Covers:
 * - Natural "python" response to clarification → pipeline continues with original rawIdea
 * - Irrelevant response → re-asks using buildClarificationMessage with session.pendingClarification
 * - Structured "Stack: node-cli" response → pipeline continues
 * - Expired clarifying session + new bootstrap candidate → starts fresh (not treated as clarification)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  registerTelegramBootstrapHook,
  _testContinueBootstrap,
  _testRecoverDueBootstraps as recoverDueBootstraps,
  _testResumeBootstrapping as resumeBootstrapping,
  _testResetActiveBootstrapResumes as resetActiveBootstrapResumes,
} from "../../lib/dispatch/telegram-bootstrap-hook.js";
import { toCanonicalTelegramBootstrapConversationId } from "../../lib/dispatch/telegram-bootstrap-session.js";

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

const sendMessageTelegram = vi.fn(async () => undefined);

const ctx = {
  pluginConfig: {
    telegram: {
      bootstrapDmEnabled: true,
      projectsForumChatId: "-1003709213169",
    },
  },
  config: {
    agents: { defaults: { workspace: "" } },
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
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-telegram-flow-"));
    handler = undefined;
    resetActiveBootstrapResumes();
    sendMessageTelegram.mockReset();
    sendMessageTelegram.mockResolvedValue(undefined);
    mockRunPipeline.mockReset();
    mockReadProjects.mockReset();
    mockProjectTick.mockReset();
    mockDiscoverAgents.mockReset();
    mockReadProjects.mockResolvedValue({ projects: {} });
    mockDiscoverAgents.mockReturnValue([{ agentId: "main", workspace: workspaceDir }]);
    mockProjectTick.mockResolvedValue({ pickups: [], skipped: [] });
    ctx.config.agents.defaults.workspace = workspaceDir;
    delete ctx.runtime.subagent;
    // Clean up session files from prior tests
    await fs.rm(path.join(workspaceDir, "fabrica", "bootstrap-sessions"), { recursive: true, force: true });

    const api = makeApi((fn) => { handler = fn; });
    registerTelegramBootstrapHook(api, ctx);
  });

  afterEach(async () => {
    resetActiveBootstrapResumes();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rm(workspaceDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOTEMPTY" || attempt === 4) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  });

  it("resumes pipeline with original rawIdea after bare 'python' clarification response (Bug J: skips name clarification)", async () => {
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

    // Step 2: user replies with bare "python" — stack resolved
    // inferProjectSlug succeeds on rawIdea → pipeline runs directly (no name clarification)
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
    // project_name should be inferred (non-null)
    expect(pipelinePayload.metadata.project_name).toBeTruthy();
  });

  it("re-asks when clarification response is irrelevant", async () => {
    // Step 1: trigger clarification
    await handler?.(
      { content: "Crie um novo projeto CLI", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    // ack sent first, then clarification question
    expect(sendMessageTelegram).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => {
      const persisted = JSON.parse(await fs.readFile(
        path.join(workspaceDir, "fabrica", "bootstrap-sessions", `${toCanonicalTelegramBootstrapConversationId(CONVERSATION_ID)}.json`),
        "utf-8",
      ));
      expect(persisted.status).toBe("clarifying");
    }, { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
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

  it("resumes pipeline after structured 'Stack: node-cli' clarification (Bug J: skips name clarification)", async () => {
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
    await vi.waitFor(async () => {
      const persisted = JSON.parse(await fs.readFile(
        path.join(workspaceDir, "fabrica", "bootstrap-sessions", `${toCanonicalTelegramBootstrapConversationId(CONVERSATION_ID)}.json`),
        "utf-8",
      ));
      expect(persisted.status).toBe("clarifying");
    }, { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    sendMessageTelegram.mockClear();

    // Step 2: structured clarification response for stack
    // inferProjectSlug succeeds on rawIdea → pipeline runs directly (no name clarification)
    await handler?.(
      { content: "Stack: node-cli", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const pipelinePayload = mockRunPipeline.mock.calls[0]?.[0];
    expect(pipelinePayload.metadata.stack_hint).toBe("node-cli");
    // project_name should be inferred (non-null)
    expect(pipelinePayload.metadata.project_name).toBeTruthy();
    // original idea preserved
    expect(pipelinePayload.raw_idea).toContain("automatizar deploys");
  });

  it("fails closed when bootstrap reaches an unsupported greenfield stack", async () => {
    await _testContinueBootstrap(
      ctx,
      CONVERSATION_ID,
      workspaceDir,
      {
        rawIdea: "Build a small Go CLI tool called port-checker with tests and a README",
        projectName: "port-checker",
        stackHint: "go",
      },
      {
        channel: "telegram",
        channelId: CONVERSATION_ID,
      },
    );

    expect(mockRunPipeline).not.toHaveBeenCalled();
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect(String(sendMessageTelegram.mock.calls[0]?.[1] ?? "")).toContain('stack "go" is not supported yet');

    const sessionRaw = await fs.readFile(
      path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`),
      "utf-8",
    );
    const session = JSON.parse(sessionRaw) as {
      status: string;
      ackSentAt?: string | null;
      error?: string | null;
      lastError?: string | null;
      stackHint?: string | null;
    };
    expect(session.status).toBe("failed");
    expect(session.ackSentAt ?? null).toBeNull();
    expect(session.stackHint).toBe("go");
    expect(session.error).toContain('stack "go" is not supported yet');
    expect(session.lastError).toContain('stack "go" is not supported yet');

    const auditLog = await fs.readFile(
      path.join(workspaceDir, "fabrica", "log", "audit.log"),
      "utf-8",
    );
    expect(auditLog).toContain('"event":"telegram_bootstrap_failed"');
    expect(auditLog).toContain('"projectSlug":"port-checker"');
    expect(auditLog).toContain('"stackHint":"go"');
    expect(auditLog).toContain('"reason":"unsupported_greenfield_stack"');
  });

  it("fails before ack when a bootstrapping session carries an unsupported stack", async () => {
    await fs.mkdir(path.join(workspaceDir, "fabrica", "bootstrap-sessions"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`),
      JSON.stringify({
        id: "tgdm-unsupported-go",
        conversationId: CONVERSATION_ID,
        sourceChannel: "telegram",
        sourceRoute: { channel: "telegram", channelId: CONVERSATION_ID },
        requestHash: "req-hash-go",
        requestFingerprint: "req-hash-go",
        rawIdea: "Build a small Go CLI tool called port-checker with tests and a README",
        projectName: "port-checker",
        stackHint: "go",
        projectSlug: "port-checker",
        status: "bootstrapping",
        bootstrapStep: "awaiting_ack",
        attemptId: "attempt-go",
        attemptSeq: 1,
        ackSentAt: null,
        language: "en",
        createdAt: "2026-04-02T10:58:00.000Z",
        updatedAt: "2026-04-02T10:58:00.000Z",
        suppressUntil: new Date(Date.now() + 60_000).toISOString(),
      }, null, 2) + "\n",
      "utf-8",
    );

    await resumeBootstrapping(ctx, workspaceDir, CONVERSATION_ID);

    expect(mockRunPipeline).not.toHaveBeenCalled();
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect(String(sendMessageTelegram.mock.calls[0]?.[1] ?? "")).toContain('stack "go" is not supported yet');

    const sessionRaw = await fs.readFile(
      path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`),
      "utf-8",
    );
    const session = JSON.parse(sessionRaw) as {
      status: string;
      ackSentAt?: string | null;
      error?: string | null;
      lastError?: string | null;
      stackHint?: string | null;
    };
    expect(session.status).toBe("failed");
    expect(session.ackSentAt ?? null).toBeNull();
    expect(session.error).toContain('stack "go" is not supported yet');
    expect(session.lastError).toContain('stack "go" is not supported yet');
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
    const sessionDir = path.join(workspaceDir, "fabrica", "bootstrap-sessions");
    const sessionFile = `${sessionDir}/${toCanonicalTelegramBootstrapConversationId(CONVERSATION_ID)}.json`;
    const raw = await fs.readFile(sessionFile, "utf-8");
    const session = JSON.parse(raw);
    session.suppressUntil = new Date(Date.now() - 60_000).toISOString();
    await fs.writeFile(sessionFile, JSON.stringify(session, null, 2) + "\n", "utf-8");
    resetActiveBootstrapResumes();

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

  it("restarts clarification when the same bootstrap candidate is retried after clarifying expiry", async () => {
    await handler?.(
      { content: "Crie um projeto CLI inicial", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    expect(sendMessageTelegram).toHaveBeenCalledTimes(2);
    sendMessageTelegram.mockClear();

    const sessionDir = path.join(workspaceDir, "fabrica", "bootstrap-sessions");
    const sessionFile = `${sessionDir}/${toCanonicalTelegramBootstrapConversationId(CONVERSATION_ID)}.json`;
    const raw = await fs.readFile(sessionFile, "utf-8");
    const session = JSON.parse(raw);
    session.suppressUntil = new Date(Date.now() - 60_000).toISOString();
    await fs.writeFile(sessionFile, JSON.stringify(session, null, 2) + "\n", "utf-8");
    resetActiveBootstrapResumes();

    await handler?.(
      { content: "Crie um projeto CLI inicial", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    expect(mockRunPipeline).not.toHaveBeenCalled();
    expect(sendMessageTelegram).toHaveBeenCalledTimes(2);
    expect(String(sendMessageTelegram.mock.calls[0]?.[1])).toContain("Recebi");
    expect(String(sendMessageTelegram.mock.calls[1]?.[1])).toContain("Qual stack");
  });

  it("proceeds to pipeline directly when stack is known and inferProjectSlug succeeds (Bug J: no name loop)", async () => {
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

    // Send DM with explicit stack but no explicit project name
    // inferProjectSlug will succeed on "Uma CLI para converter bases numericas." → pipeline runs directly
    await handler?.(
      { content: "Crie um projeto.\nStack: python-cli\nIdeia: Uma CLI para converter bases numericas.", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    await vi.waitFor(
      () => expect(mockRunPipeline).toHaveBeenCalledTimes(1),
      { timeout: 3000 },
    );
    const payload = mockRunPipeline.mock.calls[0]?.[0];
    // project_name should be inferred (non-null, not blank)
    expect(payload.metadata.project_name).toBeTruthy();
    expect(payload.metadata.stack_hint).toBe("python-cli");
  });

  it("routes a clear 'Build ... Python CLI tool called csv-peek' DM through the deterministic bootstrap path", async () => {
    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          channel_id: "-1003709213169",
          message_thread_id: 804,
          project_slug: "csv-peek",
        },
      },
    });

    await handler?.(
      {
        content: "Build a small Python CLI tool called csv-peek. Requirements: It reads a CSV file from a file path argument. By default, it prints the number of rows, the number of columns, and the column names. Add a --preview N flag to print the first N data rows. Add a --json flag to print the summary as JSON. Ignore empty trailing lines in the file. Include a README with usage examples. Include basic tests.",
        metadata: {},
      },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const payload = mockRunPipeline.mock.calls[0]?.[0];
    expect(payload.raw_idea).toContain("Build a small Python CLI tool called csv-peek");
    expect(payload.metadata.stack_hint).toBe("python-cli");
    expect(payload.metadata.project_name).toBe("csv-peek");
    expect(sendMessageTelegram.mock.calls[0]?.[0]).toBe(CONVERSATION_ID);
    expect(String(sendMessageTelegram.mock.calls[0]?.[1] ?? "")).toContain("Got it!");
  });

  it("recognizes 'Python.' (with punctuation) as stack clarification response and proceeds to pipeline", async () => {
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
    // normalizeUserResponse strips the period → detected as python-cli
    // inferProjectSlug succeeds on rawIdea → pipeline runs directly
    await handler?.(
      { content: "Python.", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    // Pipeline should be called (stack resolved, name inferred)
    await vi.waitFor(
      () => expect(mockRunPipeline).toHaveBeenCalledTimes(1),
      { timeout: 2000 },
    );
    expect(mockRunPipeline.mock.calls[0]?.[0].metadata.stack_hint).toBeTruthy();
  });

  it("re-asks with contextual name question when name clarification is not recognized", async () => {
    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: { channel_id: "-1003709213169", message_thread_id: 810, project_slug: "test" },
      },
    });

    // Seed a clarifying session in "name" pending state (rawIdea="" so inferProjectSlug=undefined)
    const sessionDir = path.join(workspaceDir, "fabrica", "bootstrap-sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      `${sessionDir}/${CONVERSATION_ID}.json`,
      JSON.stringify({
        conversationId: CONVERSATION_ID,
        rawIdea: "",
        stackHint: "python-cli",
        status: "clarifying",
        pendingClarification: "name",
        language: "pt",
        suppressUntil: new Date(Date.now() + 60_000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) + "\n",
      "utf-8",
    );

    // Send gibberish that won't match name (too long, >64 chars)
    await handler?.(
      { content: "a".repeat(65), metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    // Re-ask should be the NAME question, not a generic "more details"
    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const reAsk = String(sendMessageTelegram.mock.calls[0]?.[1]);
    expect(reAsk).toMatch(/nome|name/i);
    // Must NOT be the old generic message
    expect(reAsk).not.toContain("mais detalhes");
    expect(reAsk).not.toContain("more details");
  });

  it("recognizes bare 'Python' (no punctuation) as stack and proceeds to pipeline (Bug J: name inferred)", async () => {
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

    // Step 2: "Python" without punctuation — stack recognized
    // inferProjectSlug succeeds on rawIdea → pipeline runs directly (no name clarification)
    await handler?.(
      { content: "Python", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    await vi.waitFor(
      () => expect(mockRunPipeline).toHaveBeenCalledTimes(1),
      { timeout: 2000 },
    );
    expect(mockRunPipeline.mock.calls[0]?.[0].metadata.project_name).toBeTruthy();
  });

  it("breaks auto-name loop when inferProjectSlug returns undefined (Bug J)", async () => {
    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: { channel_id: "-1003709213169", message_thread_id: 820, project_slug: "project-fallback" },
      },
    });

    // Seed a clarifying session with an empty rawIdea to simulate the Bug J scenario:
    // inferProjectSlug("") → undefined. Without the fix, "auto" would return projectName=undefined
    // and the loop would repeat. With the fix, it returns "project-${Date.now()}".
    const sessionDir = path.join(workspaceDir, "fabrica", "bootstrap-sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      `${sessionDir}/${CONVERSATION_ID}.json`,
      JSON.stringify({
        conversationId: CONVERSATION_ID,
        rawIdea: "",
        stackHint: "python-cli",
        status: "clarifying",
        pendingClarification: "name",
        language: "pt",
        suppressUntil: new Date(Date.now() + 60_000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) + "\n",
      "utf-8",
    );

    // User says "auto" — parseClarificationResponse sees auto-pattern and returns project-${Date.now()}
    await handler?.(
      { content: "auto", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    // Pipeline should be called (no loop)
    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const payload = mockRunPipeline.mock.calls[0]?.[0];
    expect(payload.metadata.project_name).toBeTruthy();
  });

  it("recognizes 'auto.' (with punctuation) as auto-name pattern (Bug A/J interaction)", async () => {
    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: { channel_id: "-1003709213169", message_thread_id: 821, project_slug: "test" },
      },
    });

    // Seed a clarifying session with empty rawIdea
    const sessionDir = path.join(workspaceDir, "fabrica", "bootstrap-sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      `${sessionDir}/${CONVERSATION_ID}.json`,
      JSON.stringify({
        conversationId: CONVERSATION_ID,
        rawIdea: "",
        stackHint: "python-cli",
        status: "clarifying",
        pendingClarification: "name",
        language: "pt",
        suppressUntil: new Date(Date.now() + 60_000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) + "\n",
      "utf-8",
    );

    // "auto." with trailing period — normalizeUserResponse strips the period → matches "auto"
    await handler?.(
      { content: "auto.", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    // Pipeline should be called (auto-pattern matched via normalizeUserResponse)
    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const payload = mockRunPipeline.mock.calls[0]?.[0];
    expect(payload.metadata.project_name).toBeTruthy();
  });

  it("recognizes 'Node.js, and name it disk-usage-cli' as stack+name and proceeds to pipeline", async () => {
    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: { channel_id: "-1003709213169", message_thread_id: 910, project_slug: "disk-usage-cli" },
      },
    });

    // Step 1: trigger stack_and_name clarification
    await handler?.(
      { content: "Crie um projeto CLI sem especificar stack", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );
    expect(sendMessageTelegram).toHaveBeenCalledTimes(2); // ack + clarification
    sendMessageTelegram.mockClear();

    // Step 2: user replies with inline stack + project name
    await handler?.(
      { content: "Node.js, and name it disk-usage-cli", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const pipelinePayload = mockRunPipeline.mock.calls[0]?.[0];
    expect(pipelinePayload.metadata.stack_hint).toBe("node-cli");
    expect(pipelinePayload.metadata.project_name).toBe("disk-usage-cli");
  });

  it("continueBootstrap generates fallback slug when rawIdea empty and name was already asked (Bug J level 2)", async () => {
    // Seed a session with pendingClarification: "name" so level 2 guard fires
    // when continueBootstrap is called with projectName: null and rawIdea that
    // yields undefined from inferProjectSlug.
    // "@@@" → all non-word, non-hyphen chars → regex strips everything → slug "" → undefined
    const sessionDir = path.join(workspaceDir, "fabrica", "bootstrap-sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      `${sessionDir}/${CONVERSATION_ID}.json`,
      JSON.stringify({
        conversationId: CONVERSATION_ID,
        rawIdea: "@@@",
        stackHint: "python-cli",
        status: "clarifying",
        pendingClarification: "name",
        language: "pt",
        suppressUntil: new Date(Date.now() + 60_000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) + "\n",
      "utf-8",
    );

    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          channel_id: "-1003709213169",
          message_thread_id: 830,
          project_slug: "project-fallback",
        },
      },
    });

    // Call continueBootstrap directly:
    // - request.projectName is null → triggers the name resolution branch
    // - inferProjectSlug("@@@") returns undefined ("@" chars are stripped by [^\w\s-] → empty slug)
    // - existing session has pendingClarification === "name" → level 2 fires: project-${Date.now()}
    await _testContinueBootstrap(ctx, CONVERSATION_ID, workspaceDir, {
      rawIdea: "@@@",
      projectName: null,
      stackHint: "python-cli",
    }, { channel: "telegram", channelId: CONVERSATION_ID });

    // Pipeline must have been called with a timestamp-based fallback slug
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    const pipelinePayload = mockRunPipeline.mock.calls[0]?.[0];
    expect(pipelinePayload.metadata.project_name).toBeTruthy();
    expect(pipelinePayload.metadata.stack_hint).toBe("python-cli");
    expect(String(pipelinePayload.metadata.project_name)).toMatch(/^project-\d+$/);
  });

  it("does not send duplicate bootstrap acks after a resumed handoff", async () => {
    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          channel_id: "-1003709213169",
          message_thread_id: 831,
          project_slug: "todo-summary-tool",
        },
      },
    });

    ctx.runtime.subagent = {
      run: vi.fn().mockResolvedValue({ runId: "classify-run" }),
      waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
      getSessionMessages: vi.fn().mockResolvedValue([
        { role: "assistant", content: JSON.stringify({
          intent: "create_project",
          confidence: 0.95,
          stackHint: "python-cli",
          projectSlug: "todo-summary-tool",
          language: "en",
        }) },
      ]),
    };

    sendMessageTelegram
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("temporary send failure"))
      .mockResolvedValue(undefined);

    await handler?.(
      { content: "Build a simple Python CLI for todo summary", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    await vi.waitFor(() => expect(sendMessageTelegram).toHaveBeenCalledTimes(2), { timeout: 2000 });

    await resumeBootstrapping(ctx, workspaceDir, CONVERSATION_ID);

    const ackCalls = sendMessageTelegram.mock.calls.filter(
      ([target, message]) =>
        target === CONVERSATION_ID &&
        String(message).includes("Got it! I'll analyze your request and start setting up the project..."),
    );

    expect(ackCalls).toHaveLength(1);
  });

  it("uses the same single-flight launch path for LLM-started bootstraps", async () => {
    ctx.runtime.subagent = {
      run: vi.fn().mockResolvedValue({ runId: "classify-run" }),
      waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
      getSessionMessages: vi.fn().mockResolvedValue([
        { role: "assistant", content: JSON.stringify({
          intent: "create_project",
          confidence: 0.95,
          stackHint: "python-cli",
          projectSlug: "todo-summary-tool",
          language: "en",
        }) },
      ]),
    };

    let releaseAck: (() => void) | undefined;
    sendMessageTelegram
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseAck = resolve;
      }))
      .mockResolvedValue(undefined);

    const content = "Build me a Python CLI that validates CPF numbers";

    await handler?.(
      { content, metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    await vi.waitFor(async () => {
      const sessionRaw = await fs.readFile(
        path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`),
        "utf-8",
      );
      const session = JSON.parse(sessionRaw);
      expect(session.status).toBe("bootstrapping");
    }, { timeout: 2000 });

    await handler?.(
      { content, metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect(mockRunPipeline).not.toHaveBeenCalled();

    releaseAck?.();

    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it("reconciles a late classify result through bootstrap recovery after waitForRun timeout", async () => {
    const mockWaitForRun = vi.fn().mockResolvedValueOnce({ status: "timeout" });
    const mockGetSessionMessages = vi.fn()
      .mockResolvedValueOnce([
        { role: "assistant", content: JSON.stringify({
          intent: "create_project",
          confidence: 0.95,
          stackHint: "python-cli",
          projectSlug: "csv-peek",
          language: "en",
        }) },
      ]);

    ctx.runtime.subagent = {
      run: vi.fn().mockResolvedValue({ runId: "late-classify-run" }),
      waitForRun: mockWaitForRun,
      getSessionMessages: mockGetSessionMessages,
    };

    mockRunPipeline.mockResolvedValue({
      success: true,
      payload: {
        metadata: {
          channel_id: "-1003709213169",
          message_thread_id: 990,
          project_slug: "csv-peek",
        },
      },
    });

    await handler?.(
      { content: "I need a tool for summarizing CSV files", metadata: {} },
      { channelId: "telegram", conversationId: CONVERSATION_ID },
    );

    await vi.waitFor(async () => {
      const session = await fs.readFile(
        path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`),
        "utf-8",
      );
      expect(JSON.parse(session).status).toBe("classifying");
    }, { timeout: 2000 });

    expect(mockRunPipeline).not.toHaveBeenCalled();

    const recovered = await recoverDueBootstraps(ctx, workspaceDir);
    expect(recovered).toBeGreaterThan(0);

    await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const sessionRaw = await fs.readFile(
      path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`),
      "utf-8",
    );
    const session = JSON.parse(sessionRaw) as { status: string; projectRegisteredAt?: string | null };
    expect(["dispatching", "completed"]).toContain(session.status);
    expect(session.projectRegisteredAt ?? null).not.toBeNull();
  });

  it("resumes from projectRegisteredAt without rerunning registration", async () => {
    mockReadProjects.mockResolvedValue({
      projects: {
        "todo-summary-tool": {
          slug: "todo-summary-tool",
          name: "todo-summary-tool",
        },
      },
    });

    await fs.mkdir(path.join(workspaceDir, "fabrica", "bootstrap-sessions"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`),
      JSON.stringify({
        id: "tgdm-checkpointed",
        conversationId: CONVERSATION_ID,
        sourceChannel: "telegram",
        sourceRoute: { channel: "telegram", channelId: CONVERSATION_ID },
        projectRoute: {
          channel: "telegram",
          channelId: "-1003709213169",
          messageThreadId: 932,
        },
        requestHash: "req-hash",
        requestFingerprint: "req-hash",
        rawIdea: "Build a simple Python CLI for todo summary",
        projectName: "todo-summary-tool",
        stackHint: "python-cli",
        projectSlug: "todo-summary-tool",
        attemptId: "attempt-checkpointed",
        attemptSeq: 1,
        messageThreadId: 932,
        projectChannelId: "-1003709213169",
        status: "dispatching",
        ackSentAt: "2026-04-01T00:00:01.000Z",
        projectRegisteredAt: "2026-04-01T00:00:02.000Z",
        lastError: "temporary send failure",
        nextRetryAt: "2026-04-01T00:00:03.000Z",
        language: "en",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:02.000Z",
        suppressUntil: new Date(Date.now() + 60_000).toISOString(),
      }, null, 2) + "\n",
      "utf-8",
    );

    await resumeBootstrapping(ctx, workspaceDir, CONVERSATION_ID);

    expect(mockRunPipeline).not.toHaveBeenCalled();
    expect(mockProjectTick).toHaveBeenCalledTimes(1);
    expect(sendMessageTelegram).toHaveBeenCalledTimes(2);
    expect(sendMessageTelegram.mock.calls[0]?.[0]).toBe("-1003709213169");
    expect(sendMessageTelegram.mock.calls[1]?.[0]).toBe(CONVERSATION_ID);

    const persisted = JSON.parse(
      await fs.readFile(
        path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`),
        "utf-8",
      ),
    );
    expect(persisted.status).toBe("completed");
    expect(persisted.lastError).toBeNull();
    expect(persisted.nextRetryAt).toBeNull();
  });

  it("does not replay kickoff or projectTick after a later dispatch failure", async () => {
    await fs.mkdir(path.join(workspaceDir, "fabrica", "bootstrap-sessions"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`),
      JSON.stringify({
        id: "tgdm-dispatch-retry",
        conversationId: CONVERSATION_ID,
        sourceChannel: "telegram",
        sourceRoute: { channel: "telegram", channelId: CONVERSATION_ID },
        projectRoute: {
          channel: "telegram",
          channelId: "-1003709213169",
          messageThreadId: 944,
        },
        requestHash: "req-hash",
        requestFingerprint: "req-hash",
        rawIdea: "Build a simple Python CLI for todo summary",
        projectName: "todo-summary-tool",
        stackHint: "python-cli",
        projectSlug: "todo-summary-tool",
        attemptId: "attempt-dispatch-retry",
        attemptSeq: 1,
        messageThreadId: 944,
        projectChannelId: "-1003709213169",
        status: "dispatching",
        ackSentAt: "2026-04-01T00:00:01.000Z",
        projectRegisteredAt: "2026-04-01T00:00:02.000Z",
        topicKickoffSentAt: "2026-04-01T00:00:03.000Z",
        projectTickedAt: "2026-04-01T00:00:04.000Z",
        lastError: "dm ack failed",
        nextRetryAt: "2026-04-01T00:00:05.000Z",
        language: "en",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:05.000Z",
        suppressUntil: new Date(Date.now() + 60_000).toISOString(),
      }, null, 2) + "\n",
      "utf-8",
    );

    sendMessageTelegram
      .mockRejectedValueOnce(new Error("dm ack failed"))
      .mockResolvedValue(undefined);

    await resumeBootstrapping(ctx, workspaceDir, CONVERSATION_ID);
    await resumeBootstrapping(ctx, workspaceDir, CONVERSATION_ID);

    expect(mockRunPipeline).not.toHaveBeenCalled();
    expect(mockProjectTick).not.toHaveBeenCalled();
    expect(sendMessageTelegram).toHaveBeenCalledTimes(2);
    expect(sendMessageTelegram.mock.calls[0]?.[0]).toBe(CONVERSATION_ID);
    expect(sendMessageTelegram.mock.calls[1]?.[0]).toBe(CONVERSATION_ID);
    expect(sendMessageTelegram.mock.calls.some(([target]) => target === "-1003709213169")).toBe(false);

    const persisted = JSON.parse(
      await fs.readFile(
        path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`),
        "utf-8",
      ),
    );
    expect(persisted.status).toBe("completed");
    expect(persisted.lastError).toBeNull();
    expect(persisted.nextRetryAt).toBeNull();
  });

  it("keeps projectTick retryable when pickup fails during dispatch recovery", async () => {
    await fs.mkdir(path.join(workspaceDir, "fabrica", "bootstrap-sessions"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`),
      JSON.stringify({
        id: "tgdm-projecttick-retry",
        conversationId: CONVERSATION_ID,
        sourceChannel: "telegram",
        sourceRoute: { channel: "telegram", channelId: CONVERSATION_ID },
        projectRoute: {
          channel: "telegram",
          channelId: "-1003709213169",
          messageThreadId: 945,
        },
        requestHash: "req-hash",
        requestFingerprint: "req-hash",
        rawIdea: "Build a simple Python CLI for todo summary",
        projectName: "todo-summary-tool",
        stackHint: "python-cli",
        projectSlug: "todo-summary-tool",
        attemptId: "attempt-projecttick-retry",
        attemptSeq: 1,
        messageThreadId: 945,
        projectChannelId: "-1003709213169",
        status: "dispatching",
        ackSentAt: "2026-04-01T00:00:01.000Z",
        projectRegisteredAt: "2026-04-01T00:00:02.000Z",
        topicKickoffSentAt: "2026-04-01T00:00:03.000Z",
        lastError: "temporary send failure",
        nextRetryAt: "2026-04-01T00:00:05.000Z",
        language: "en",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:05.000Z",
        suppressUntil: new Date(Date.now() + 60_000).toISOString(),
      }, null, 2) + "\n",
      "utf-8",
    );

    mockProjectTick
      .mockRejectedValueOnce(new Error("pickup failed"))
      .mockResolvedValueOnce({ pickups: [], skipped: [] });

    await resumeBootstrapping(ctx, workspaceDir, CONVERSATION_ID);

    let persisted = JSON.parse(
      await fs.readFile(
        path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`),
        "utf-8",
      ),
    );
    expect(mockProjectTick).toHaveBeenCalledTimes(1);
    expect(sendMessageTelegram).not.toHaveBeenCalled();
    expect(persisted.status).toBe("dispatching");
    expect(persisted.projectTickedAt).toBeNull();
    expect(persisted.completionAckSentAt).toBeNull();
    expect(persisted.lastError).toContain("pickup failed");
    expect(persisted.nextRetryAt).toBeTruthy();
    expect(Date.parse(persisted.nextRetryAt)).toBeGreaterThan(Date.now());

    await resumeBootstrapping(ctx, workspaceDir, CONVERSATION_ID);

    persisted = JSON.parse(
      await fs.readFile(
        path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`),
        "utf-8",
      ),
    );
    expect(mockProjectTick).toHaveBeenCalledTimes(2);
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect(sendMessageTelegram.mock.calls[0]?.[0]).toBe(CONVERSATION_ID);
    expect(persisted.status).toBe("completed");
    expect(persisted.projectTickedAt).toBeTruthy();
    expect(persisted.completionAckSentAt).toBeTruthy();
    expect(persisted.nextRetryAt).toBeNull();
  });

  it("treats metadata.project_registered as the single registration truth on pipeline failure", async () => {
    mockRunPipeline.mockResolvedValue({
      success: false,
      error: "register step failed after repo registration",
      payload: {
        metadata: {
          project_registered: true,
          project_slug: "registered-project",
        },
      },
      artifacts: [
        { type: "github_repo", id: "https://github.com/acme/registered-project" },
      ],
    });

    await _testContinueBootstrap(
      ctx,
      CONVERSATION_ID,
      workspaceDir,
      {
        rawIdea: "Crie um projeto para processar arquivos CSV",
        projectName: "registered-project",
        stackHint: "python-cli",
      },
      {
        channel: "telegram",
        channelId: CONVERSATION_ID,
      },
    );

    const sessionRaw = await fs.readFile(path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`), "utf-8");
    const session = JSON.parse(sessionRaw) as { status: string; error?: string | null };

    expect(session.status).toBe("failed");
    expect(session.status).not.toBe("orphaned_repo");
    expect(session.error).toContain("register step failed");
    expect(String(sendMessageTelegram.mock.calls.at(-1)?.[1] ?? "")).toContain("Nao consegui registrar o projeto automaticamente");
  });

  it("stops the successful pipeline path when ownership changes before project_registered is persisted", async () => {
    await fs.mkdir(path.join(workspaceDir, "fabrica", "bootstrap-sessions"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`),
      JSON.stringify({
        id: "tgdm-owner-loss",
        conversationId: CONVERSATION_ID,
        sourceChannel: "telegram",
        sourceRoute: { channel: "telegram", channelId: CONVERSATION_ID },
        requestHash: "req-hash",
        requestFingerprint: "req-hash",
        rawIdea: "Build a simple Python CLI for todo summary",
        projectName: "todo-summary-tool",
        stackHint: "python-cli",
        projectSlug: "todo-summary-tool",
        status: "bootstrapping",
        bootstrapStep: "awaiting_pipeline",
        attemptId: "attempt-1",
        attemptSeq: 1,
        ackSentAt: "2026-04-01T00:00:01.000Z",
        language: "en",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:01.000Z",
        suppressUntil: new Date(Date.now() + 60_000).toISOString(),
      }, null, 2) + "\n",
      "utf-8",
    );

    mockRunPipeline.mockImplementationOnce(async () => {
      await fs.writeFile(
        path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`),
        JSON.stringify({
          id: "tgdm-owner-loss-new",
          conversationId: CONVERSATION_ID,
          sourceChannel: "telegram",
          sourceRoute: { channel: "telegram", channelId: CONVERSATION_ID },
          requestHash: "req-hash-new",
          requestFingerprint: "req-hash-new",
          rawIdea: "Build the replacement summary service",
          projectName: "replacement-summary-service",
          stackHint: "python-cli",
          projectSlug: "replacement-summary-service",
          status: "bootstrapping",
          bootstrapStep: "awaiting_pipeline",
          attemptId: "attempt-2",
          attemptSeq: 2,
          ackSentAt: "2026-04-01T00:00:10.000Z",
          language: "en",
          createdAt: "2026-04-01T00:00:09.000Z",
          updatedAt: "2026-04-01T00:00:10.000Z",
          suppressUntil: new Date(Date.now() + 60_000).toISOString(),
        }, null, 2) + "\n",
        "utf-8",
      );

      return {
        success: true,
        payload: {
          metadata: {
            channel_id: "-1003709213169",
            message_thread_id: 977,
            project_slug: "todo-summary-tool",
          },
        },
      };
    });

    await _testContinueBootstrap(
      ctx,
      CONVERSATION_ID,
      workspaceDir,
      {
        rawIdea: "Build a simple Python CLI for todo summary",
        projectName: "todo-summary-tool",
        stackHint: "python-cli",
      },
      {
        channel: "telegram",
        channelId: CONVERSATION_ID,
      },
    );

    expect(sendMessageTelegram).not.toHaveBeenCalled();
    expect(mockProjectTick).not.toHaveBeenCalled();

    const persisted = JSON.parse(
      await fs.readFile(
        path.join(workspaceDir, "fabrica", "bootstrap-sessions", `telegram:${CONVERSATION_ID}.json`),
        "utf-8",
      ),
    );
    expect(persisted.attemptId).toBe("attempt-2");
    expect(persisted.projectName).toBe("replacement-summary-service");
    expect(persisted.projectRegisteredAt ?? null).toBeNull();
    expect(persisted.messageThreadId ?? null).toBeNull();
    expect(persisted.projectChannelId ?? null).toBeNull();
    expect(persisted.status).toBe("bootstrapping");
  });
});
