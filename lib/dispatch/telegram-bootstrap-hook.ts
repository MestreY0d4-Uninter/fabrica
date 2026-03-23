import { homedir } from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginContext } from "../context.js";
import { resolveWorkspaceDir } from "./attachment-hook.js";
import { runPipeline, type GenesisPayload, type StepContext } from "../intake/index.js";
import { createProvider } from "../providers/index.js";
import { readFabricaTelegramConfig } from "../telegram/config.js";
import { readProjects } from "../projects/index.js";
import { discoverAgents } from "../services/heartbeat/agent-discovery.js";
import { projectTick } from "../services/tick.js";
import { resolveOpenClawCli } from "../intake/lib/runtime-paths.js";
import { extractJsonFromStdout } from "../intake/lib/extract-json.js";
import { z } from "zod";
import {
  buildBootstrapRequestHash,
  deleteTelegramBootstrapSession,
  readTelegramBootstrapSession,
  shouldSuppressTelegramBootstrapReply,
  upsertTelegramBootstrapSession,
  type TelegramBootstrapSession,
} from "./telegram-bootstrap-session.js";

type BootstrapRequest = {
  rawIdea: string;
  projectName?: string;
  repoUrl?: string;
  repoPath?: string;
  stackHint?: string;
};

type TelegramBootstrapRoute = {
  channel: string;
  channelId: string;
  messageThreadId?: number | null;
  accountId?: string | null;
};

type BootstrapLanguage = "pt" | "en";

const BOOTSTRAP_MESSAGES = {
  ack: {
    pt: "Recebi! Vou analisar e começar a montar o projeto...",
    en: "Got it! I'll analyze your request and start setting up the project...",
  },
  clarifyStack: {
    pt: "Qual stack você quer usar? (Python, Node.js, Go, Java...)",
    en: "Which stack do you want to use? (Python, Node.js, Go, Java...)",
  },
  clarifyBoth: {
    pt: "Beleza! Só preciso de duas coisas pra criar:\n\n1. Qual stack? (Python, Node.js, Go, Java...)\n2. Quer dar um nome pro projeto? Se não, eu invento um.",
    en: "Great! I just need two things:\n\n1. Which stack? (Python, Node.js, Go, Java...)\n2. Want to name the project? If not, I'll pick one.",
  },
  clarifyStackFollowUp: {
    pt: "Não consegui identificar a stack. Pode me dizer qual linguagem/framework você quer usar? Ex: Python, Node.js, Go, Java...",
    en: "Couldn't identify the stack. Can you tell me which language/framework you'd like to use? e.g., Python, Node.js, Go, Java...",
  },
  registered: {
    pt: (name: string, link: string) => `Projeto "${name}" registrado.\nVou continuar o fluxo em ${link}`,
    en: (name: string, link: string) => `Project "${name}" registered.\nI'll continue the flow at ${link}`,
  },
} as const;

function inferProjectSlug(text: string): string | undefined {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 64);
  return slug || undefined;
}

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function detectStackHint(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (/\b(nextjs|next\.js)\b/.test(lower)) return "nextjs";
  if (/\b(node-cli|typescript cli|ts cli|cli em typescript|typescript command line|typescript terminal cli)\b/.test(lower)) return "node-cli";
  if (/\bexpress\b/.test(lower)) return "express";
  if (/\b(fastapi)\b/.test(lower)) return "fastapi";
  if (/\b(flask)\b/.test(lower)) return "flask";
  if (/\b(django)\b/.test(lower)) return "django";
  if (/\bpython-cli|python cli|cli em python|cli python\b/.test(lower)) return "python-cli";
  if (/\bjava\b/.test(lower)) return "java";
  if (/\bgo\b/.test(lower)) return "go";
  return undefined;
}

function parseField(text: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const regex = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im");
    const match = text.match(regex);
    if (match?.[1]) return normalizeText(match[1]);
  }
  return undefined;
}

function parseIdeaBlock(text: string): string | undefined {
  const match = text.match(/^\s*(idea|ideia|objetivo)\s*:\s*([\s\S]+)$/im);
  return normalizeText(match?.[2]);
}

function parseBootstrapRequest(text: string): BootstrapRequest {
  const repoUrl = parseField(text, ["repository url", "repo url", "reposit[oó]rio url", "github repo"]);
  const rawIdea = parseIdeaBlock(text) ?? text.trim();
  const projectName = parseField(text, ["project name", "nome do projeto", "repo name", "repository name"]);
  const repoPath = parseField(text, ["local repository path", "repo path", "caminho local", "local path"]);
  const stackHint = parseField(text, ["stack", "framework", "linguagem"]) ?? detectStackHint(text);
  return {
    rawIdea,
    projectName,
    repoUrl,
    repoPath,
    stackHint,
  };
}

const MAX_CLASSIFY_LENGTH = 500;

function isAmbiguousCandidate(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.length <= 20 || lower.length > MAX_CLASSIFY_LENGTH) return false;
  const softwareCue = /\b(projeto|project|cli|api|app|aplicativo|servi[cç]o|library|biblioteca|repo|reposit[oó]rio|tool|ferramenta|sistema|system|bot|script|programa|program)\b/.test(lower);
  return softwareCue;
}

type DmIntentClassification = {
  intent: "create_project" | "other";
  confidence: number;
  stackHint?: string | null;
  projectSlug?: string | null;
  language: "pt" | "en";
};

const DmIntentSchema = z.object({
  intent: z.enum(["create_project", "other"]),
  confidence: z.number().min(0).max(1),
  stackHint: z.string().nullable().optional(),
  projectSlug: z.string().nullable().optional(),
  language: z.enum(["pt", "en"]).optional().default("pt"),
});

const CLASSIFY_PROMPT_TEMPLATE = `Classify this Telegram DM. Is the user asking to create/build a new software project, or is it something else (question, greeting, status check)?

Message: "$CONTENT"

Return ONLY valid JSON:
{"intent": "create_project" | "other", "confidence": 0.0-1.0, "stackHint": "<detected stack or null>", "projectSlug": "<suggested slug or null>", "language": "pt" | "en"}

Examples:
- "Cria uma CLI Python que valida CPF" → {"intent":"create_project","confidence":0.95,"stackHint":"python-cli","projectSlug":"validador-cpf-cli","language":"pt"}
- "Build me a REST API for tasks" → {"intent":"create_project","confidence":0.9,"stackHint":"fastapi","projectSlug":"task-api","language":"en"}
- "How's the project going?" → {"intent":"other","confidence":0.95,"stackHint":null,"projectSlug":null,"language":"en"}
- "Oi, tudo bem?" → {"intent":"other","confidence":0.99,"stackHint":null,"projectSlug":null,"language":"pt"}
- "Me faz um app que converte temperaturas" → {"intent":"create_project","confidence":0.9,"stackHint":null,"projectSlug":"conversor-temperaturas","language":"pt"}`;

async function classifyDmIntent(
  ctx: PluginContext,
  content: string,
  workspaceDir: string,
): Promise<DmIntentClassification | null> {
  try {
    const truncated = content.slice(0, MAX_CLASSIFY_LENGTH);
    const prompt = CLASSIFY_PROMPT_TEMPLATE.replace("$CONTENT", truncated.replace(/"/g, '\\"'));
    const cliPath = resolveOpenClawCli({ homeDir: homedir(), workspaceDir });
    const sessionId = `dm-classify-${Date.now()}`;

    const result = await ctx.runCommand(
      [cliPath, "agent", "--local", "-m", prompt, "--session-id", sessionId, "--json"],
      { timeoutMs: 15_000 },
    );

    const stdout = result.stdout ?? "";
    if (!stdout.trim()) return null;

    const parsed = extractJsonFromStdout(stdout);
    if (!parsed) return null;

    // The LLM response wraps in { payloads: [{ text: "..." }] }
    const text = parsed?.payloads?.[0]?.text;
    const jsonStr = text
      ? text.replace(/^```(json)?/gm, "").replace(/```$/gm, "").trim()
      : JSON.stringify(parsed);

    const intentData = JSON.parse(jsonStr);
    const validated = DmIntentSchema.safeParse(intentData);
    if (!validated.success) return null;

    return validated.data;
  } catch {
    return null;
  }
}

export { isAmbiguousCandidate as _testIsAmbiguousCandidate, classifyDmIntent as _testClassifyDmIntent };

function isBootstrapCandidate(text: string): boolean {
  const lower = text.toLowerCase();
  if (/^\s*(project name|nome do projeto|repository url|repo url|stack)\s*:/im.test(text)) return true;
  const createCue = /\b(crie|cria|criar|create|register|registre|construa|desenvolva|novo projeto|new project)\b/.test(lower);
  const softwareCue = /\b(projeto|project|cli|api|app|aplicativo|servi[cç]o|library|biblioteca|repo|reposit[oó]rio)\b/.test(lower);
  return createCue && softwareCue;
}

function parseClarificationResponse(text: string, session: TelegramBootstrapSession): {
  recognized: boolean;
  stackHint?: string;
  projectName?: string;
} {
  // Try structured field format first (e.g. "Stack: python-cli")
  const stackField = parseField(text, ["stack", "framework", "linguagem", "language"]);
  if (stackField) {
    return { recognized: true, stackHint: detectStackHint(stackField) ?? stackField };
  }
  // Try direct stack hint detection on the whole message
  const detectedStack = detectStackHint(text);
  if (detectedStack) {
    return { recognized: true, stackHint: detectedStack };
  }
  // Detect bare language names as stack hints
  const lower = text.toLowerCase().trim();
  const bareStackMap: Record<string, string> = {
    python: "python-cli",
    py: "python-cli",
    node: "node-cli",
    nodejs: "node-cli",
    "node.js": "node-cli",
    typescript: "node-cli",
    ts: "node-cli",
    javascript: "node-cli",
    js: "node-cli",
    golang: "go",
    rust: "rust",
    java: "java",
  };
  for (const [key, val] of Object.entries(bareStackMap)) {
    if (lower === key || lower.startsWith(key + " ") || lower.includes(` ${key}`) || lower.includes(`em ${key}`) || lower.includes(`usar ${key}`) || lower.includes(`use ${key}`) || lower.includes(`quero ${key}`)) {
      return { recognized: true, stackHint: val };
    }
  }
  // Try project name from the clarification context
  const projectNameField = parseField(text, ["project name", "nome do projeto", "nome", "name"]);
  if (projectNameField) {
    return { recognized: true, projectName: projectNameField, stackHint: session.stackHint ?? undefined };
  }
  return { recognized: false };
}

function buildClarificationMessage(parsed: BootstrapRequest, pendingClarification?: "stack" | "stack_and_name", language: BootstrapLanguage = "pt"): string {
  if (pendingClarification === "stack_and_name" || (!parsed.stackHint && !parsed.projectName)) {
    return BOOTSTRAP_MESSAGES.clarifyBoth[language];
  }
  return BOOTSTRAP_MESSAGES.clarifyStack[language];
}

function buildFollowUpClarification(session: TelegramBootstrapSession): string {
  const lang: BootstrapLanguage = session.language ?? "pt";
  if (!session.stackHint) return BOOTSTRAP_MESSAGES.clarifyStackFollowUp[lang];
  return lang === "en"
    ? "Can you give me more details about what you want to build?"
    : "Pode me dar mais detalhes sobre o que você quer construir?";
}

function buildDmAck(projectName: string, topicLink: string, language: BootstrapLanguage = "pt"): string {
  return BOOTSTRAP_MESSAGES.registered[language](projectName, topicLink);
}

function buildTopicKickoff(projectName: string, idea: string): string {
  return [
    `🧱 Projeto registrado automaticamente pela Fabrica.`,
    `Projeto: ${projectName}`,
    "",
    "Resumo do pedido inicial:",
    idea,
  ].join("\n");
}

async function sendTelegramText(
  ctx: PluginContext,
  target: string,
  message: string,
  opts?: { accountId?: string; messageThreadId?: number },
): Promise<void> {
  const sendOpts: Record<string, unknown> = {
    silent: true,
    disableWebPagePreview: true,
  };
  if (opts?.accountId) sendOpts.accountId = opts.accountId;
  if (opts?.messageThreadId != null) sendOpts.messageThreadId = opts.messageThreadId;
  await ctx.runtime.channel.telegram.sendMessageTelegram(target, message, sendOpts as any);
}

function logBootstrapWarning(ctx: PluginContext, message: string): void {
  if (typeof ctx.logger?.warn === "function") {
    ctx.logger.warn(message);
    return;
  }
  if (typeof ctx.logger?.info === "function") {
    ctx.logger.info(message);
  }
}

/**
 * Layer 3: LLM-based classification for ambiguous DMs.
 * Classifies the message via classifyDmIntent. If LLM returns null, "other", or
 * low confidence (< 0.7), deletes the classifying session (fail-open to chat).
 * If "create_project" with confidence >= 0.7, sends ack, merges LLM enrichment
 * into the parsed request, deduplicates, and enters clarification or fires the pipeline.
 */
async function classifyAndBootstrap(
  ctx: PluginContext,
  workspaceDir: string,
  conversationId: string,
  content: string,
): Promise<void> {
  const classification = await classifyDmIntent(ctx, content, workspaceDir);

  // Fail-open: if LLM failed or returned "other" or low confidence, delete session so agent can respond
  if (!classification || classification.intent !== "create_project" || classification.confidence < 0.7) {
    if (!classification) {
      logBootstrapWarning(ctx, `[telegram-bootstrap] LLM classify failed, falling back (conversation: ${conversationId})`);
    }
    await deleteTelegramBootstrapSession(workspaceDir, conversationId);
    return;
  }

  // LLM says create_project with high confidence — send ack
  const language: BootstrapLanguage = classification.language ?? "pt";
  await sendTelegramText(ctx, conversationId, BOOTSTRAP_MESSAGES.ack[language]);

  // Parse the original content with existing regex parser, then merge LLM enrichment
  const parsed = parseBootstrapRequest(content);
  if (classification.stackHint && !parsed.stackHint) {
    parsed.stackHint = classification.stackHint;
  }
  if (classification.projectSlug && !parsed.projectName) {
    parsed.projectName = classification.projectSlug;
  }

  const incomingRequest = {
    rawIdea: parsed.rawIdea,
    projectName: parsed.projectName ?? null,
    stackHint: parsed.stackHint ?? null,
    repoUrl: parsed.repoUrl ?? null,
    repoPath: parsed.repoPath ?? null,
  };

  // Dedup check — same logic as Layer 2
  const incomingRequestHash = buildBootstrapRequestHash(incomingRequest);
  const sessionForHash = await readTelegramBootstrapSession(workspaceDir, conversationId);
  if (sessionForHash?.requestHash === incomingRequestHash) {
    if (sessionForHash.status === "completed") {
      ctx.logger.info(`[telegram-bootstrap] duplicate completed DM ignored (LLM path) for conversation ${conversationId}`);
      return;
    }
    const isExpiredReceived =
      sessionForHash.status === "received" &&
      Date.parse(sessionForHash.suppressUntil) < Date.now();
    if (sessionForHash.status !== "failed" && sessionForHash.status !== "classifying" && !isExpiredReceived) {
      ctx.logger.info(`[telegram-bootstrap] duplicate in-flight DM ignored (LLM path) for conversation ${conversationId}`);
      return;
    }
  }

  const sourceRoute: TelegramBootstrapRoute = { channel: "telegram", channelId: conversationId };

  // Upsert session with "received" status
  const session = await upsertTelegramBootstrapSession(workspaceDir, {
    conversationId,
    ...incomingRequest,
    sourceRoute,
    sourceChannel: "telegram",
    status: "received",
  });

  // If no stack hint, enter clarification flow (same as Layer 2)
  if (!parsed.stackHint) {
    const pendingClarification = !parsed.projectName ? "stack_and_name" as const : "stack" as const;
    await upsertTelegramBootstrapSession(workspaceDir, {
      conversationId,
      ...incomingRequest,
      sourceRoute: session.sourceRoute,
      status: "clarifying",
      pendingClarification,
    });
    await sendTelegramText(ctx, conversationId, buildClarificationMessage(parsed, pendingClarification, language));
    return;
  }

  // Fire-and-forget pipeline
  continueBootstrap(ctx, conversationId, workspaceDir, incomingRequest, sourceRoute).catch((err) => {
    logBootstrapWarning(ctx, `[telegram-bootstrap] unhandled pipeline error (LLM path): ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Execute the bootstrap pipeline after stack/project info is resolved.
 * Contains the preflight check for projectsForumChatId and the full pipeline.
 */
async function continueBootstrap(
  ctx: PluginContext,
  conversationId: string,
  workspaceDir: string,
  request: {
    rawIdea: string;
    projectName?: string | null;
    stackHint?: string | null;
    repoUrl?: string | null;
    repoPath?: string | null;
  },
  sourceRoute: TelegramBootstrapRoute,
): Promise<void> {
  const telegramConfig = readFabricaTelegramConfig(ctx.pluginConfig);
  if (!telegramConfig.projectsForumChatId) {
    await sendTelegramText(ctx, conversationId,
      "A Fabrica precisa de um grupo de projetos configurado para criar projetos automaticamente. " +
      "Configure 'telegram.projectsForumChatId' no openclaw.json do plugin.",
    );
    return;
  }

  const projectName = request.projectName ?? undefined;
  const stackHint = request.stackHint!;

  const candidateSlug = inferProjectSlug(projectName ?? request.rawIdea);
  if (candidateSlug) {
    const projects = await readProjects(workspaceDir).catch(() => null);
    if (projects?.projects?.[candidateSlug]) {
      await sendTelegramText(
        ctx,
        conversationId,
        `Ja existe um projeto registrado com o slug "${candidateSlug}". Use o fluxo administrativo para vincular canais ou ajustar o projeto existente.`,
      );
      return;
    }
  }

  const stepCtx: StepContext = {
    runCommand: async (cmd, args, opts) => {
      const result = await ctx.runCommand([cmd, ...args], {
        timeoutMs: opts?.timeout ?? 60_000,
        cwd: opts?.cwd,
        env: opts?.env,
      });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: (result as any).code ?? 0,
      };
    },
    createIssueProvider: async (opts) => createProvider({
      repoPath: opts.repoPath,
      repo: opts.repo,
      provider: opts.provider,
      providerProfile: opts.providerProfile,
      pluginConfig: ctx.pluginConfig,
      runCommand: ctx.runCommand,
    }),
    log: (msg) => ctx.logger.info(`[telegram-bootstrap] ${msg}`),
    homeDir: homedir(),
    workspaceDir,
    runtime: ctx.runtime,
    config: ctx.config as Record<string, unknown>,
    pluginConfig: ctx.pluginConfig,
  };

  const payload: GenesisPayload = {
    session_id: `telegram-bootstrap-${Date.now()}`,
    timestamp: new Date().toISOString(),
    step: "init",
    raw_idea: request.rawIdea,
    answers: {},
    metadata: {
      source: "telegram-dm-bootstrap",
      factory_change: false,
      project_name: projectName ?? null,
      repo_url: request.repoUrl ?? null,
      repo_path: request.repoPath ?? null,
      stack_hint: stackHint,
      channel_id: conversationId,
    },
  };

  // Re-read the current session for sourceRoute reference
  const currentSession = await readTelegramBootstrapSession(workspaceDir, conversationId);
  const incomingRequest = {
    rawIdea: request.rawIdea,
    projectName: request.projectName ?? null,
    stackHint: request.stackHint ?? null,
    repoUrl: request.repoUrl ?? null,
    repoPath: request.repoPath ?? null,
  };

  const result = await runPipeline(payload, stepCtx);
  if (!result.success) {
    // Detect orphaned repo: repo was created but project registration failed
    const orphanedRepoArtifact = result.artifacts?.find(a => a.type === "github_repo" || a.type === "gitlab_repo");
    const projectRegistered = result.payload?.project_registered === true;
    if (orphanedRepoArtifact && !projectRegistered) {
      await upsertTelegramBootstrapSession(workspaceDir, {
        conversationId,
        ...incomingRequest,
        sourceRoute,
        status: "orphaned_repo",
        projectSlug: result.payload?.metadata?.project_slug ?? undefined,
        orphanedArtifacts: result.artifacts ?? [],
        error: result.error ?? "pipeline_failed_after_repo_creation",
      });
      await sendTelegramText(
        ctx,
        conversationId,
        `O repositorio foi criado (${orphanedRepoArtifact.id}), mas o registro do projeto falhou.\n\nErro: ${result.error ?? "erro desconhecido"}\n\nVerifique o repositorio e registre o projeto manualmente se necessario.`,
      );
      return;
    }
    await upsertTelegramBootstrapSession(workspaceDir, {
      conversationId,
      ...incomingRequest,
      sourceRoute,
      status: "failed",
      projectSlug: result.payload?.metadata?.project_slug ?? undefined,
      error: result.error ?? "pipeline_failed",
    });
    await sendTelegramText(
      ctx,
      conversationId,
      `Nao consegui registrar o projeto automaticamente.\n\nErro: ${result.error ?? "erro desconhecido"}`,
    );
    return;
  }

  const resolvedProjectName =
    result.payload.metadata.project_name
    ?? result.payload.metadata.project_slug
    ?? projectName
    ?? "projeto";
  const projectChannelId = result.payload.metadata.channel_id ?? telegramConfig.projectsForumChatId;
  const messageThreadId = result.payload.metadata.message_thread_id;
  const projectSlug = result.payload.metadata.project_slug ?? result.payload.scaffold?.project_slug ?? null;

  if (projectChannelId && messageThreadId) {
    await upsertTelegramBootstrapSession(workspaceDir, {
      conversationId,
      ...incomingRequest,
      sourceRoute,
      status: "dispatching",
      projectSlug: projectSlug ?? undefined,
      projectRoute: {
        channel: "telegram",
        channelId: String(projectChannelId),
        messageThreadId,
        accountId: telegramConfig.projectsForumAccountId ?? undefined,
      },
    });
    await sendTelegramText(ctx, projectChannelId, buildTopicKickoff(resolvedProjectName, request.rawIdea), {
      accountId: telegramConfig.projectsForumAccountId,
      messageThreadId,
    });
    const agents = discoverAgents(ctx.config);
    const primaryAgent = agents[0];
    if (projectSlug && primaryAgent) {
      await projectTick({
        workspaceDir: primaryAgent.workspace,
        projectSlug,
        agentId: primaryAgent.agentId,
        pluginConfig: ctx.pluginConfig,
        runtime: ctx.runtime,
        runCommand: ctx.runCommand,
        maxPickups: 1,
      }).catch((error) => {
        logBootstrapWarning(ctx, `[telegram-bootstrap] immediate projectTick failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    await sendTelegramText(ctx, conversationId, buildDmAck(resolvedProjectName, `${projectChannelId}:${messageThreadId}`));
    await upsertTelegramBootstrapSession(workspaceDir, {
      conversationId,
      ...incomingRequest,
      sourceRoute,
      status: "completed",
      projectSlug: projectSlug ?? undefined,
      projectRoute: {
        channel: "telegram",
        channelId: String(projectChannelId),
        messageThreadId,
        accountId: telegramConfig.projectsForumAccountId ?? undefined,
      },
    });
    return;
  }

  logBootstrapWarning(ctx, `[telegram-bootstrap] pipeline completed without a project topic for "${resolvedProjectName}"`);
  await upsertTelegramBootstrapSession(workspaceDir, {
    conversationId,
    ...incomingRequest,
    sourceRoute,
    status: "failed",
    projectSlug: projectSlug ?? undefined,
    error: "missing_telegram_topic",
  });
  await sendTelegramText(
    ctx,
    conversationId,
    `Nao consegui concluir o bootstrap do projeto "${resolvedProjectName}" porque faltou a associacao obrigatoria com um topico Telegram. O projeto nao foi considerado registrado para o fluxo automatico.`,
  );
}

export function registerTelegramBootstrapHook(api: OpenClawPluginApi, ctx: PluginContext): void {
  api.on("before_prompt_build", async (_event, eventCtx) => {
    const hookCtx = eventCtx as { channelId?: string; conversationId?: string | null };
    if (hookCtx.channelId !== "telegram") return {};
    const conversationId = String(hookCtx.conversationId ?? "").trim();
    if (!conversationId || conversationId.includes(":topic:") || conversationId.startsWith("-")) return {};

    const workspaceDir = resolveWorkspaceDir(ctx.config as Record<string, unknown>);
    if (!workspaceDir) return {};

    const session = await readTelegramBootstrapSession(workspaceDir, conversationId);
    if (!shouldSuppressTelegramBootstrapReply(session)) return {};

    return {
      prependSystemContext: [
        "This Telegram DM bootstrap conversation is being handled out-of-band by Fabrica.",
        "Do not call genesis, tasks_status, or other orchestration tools for this turn.",
        "Reply with exactly: NO_REPLY",
      ].join("\n"),
    };
  });

  // Hard-suppress: cancel agent-originated messages during active bootstrap sessions.
  // Complements the soft-suppress in before_prompt_build — the LLM sometimes ignores
  // the "Reply with NO_REPLY" instruction, so this hook guarantees nothing is sent.
  // sendTelegramText() uses ctx.runtime.channel.telegram.sendMessageTelegram() directly,
  // bypassing the agent message pipeline — this hook will NOT cancel our own messages.
  api.on("message_sending", async (_event, eventCtx) => {
    const hookCtx = eventCtx as { channelId?: string; conversationId?: string | null };
    if (hookCtx.channelId !== "telegram") return;
    const conversationId = String(hookCtx.conversationId ?? "").trim();
    if (!conversationId || conversationId.includes(":topic:") || conversationId.startsWith("-")) return;

    const workspaceDir = resolveWorkspaceDir(ctx.config as Record<string, unknown>);
    if (!workspaceDir) return;

    const session = await readTelegramBootstrapSession(workspaceDir, conversationId);
    // Only suppress for active (non-terminal) sessions. Completed/failed sessions
    // should not block subsequent agent responses.
    if (
      session &&
      session.status !== "completed" &&
      session.status !== "failed" &&
      shouldSuppressTelegramBootstrapReply(session)
    ) {
      return { cancel: true };
    }
  });

  api.on("message_received", async (event, eventCtx) => {
    if (eventCtx.channelId !== "telegram") return;
    const telegramConfig = readFabricaTelegramConfig(ctx.pluginConfig);
    if (!telegramConfig.bootstrapDmEnabled) return;

    const conversationId = String(eventCtx.conversationId ?? "").trim();
    const content = String(event.content ?? "").trim();
    if (!conversationId || !content) return;

    // DM-only bootstrap: positive Telegram IDs, no topic suffix.
    if (conversationId.includes(":topic:") || conversationId.startsWith("-")) return;

    const workspaceDir = resolveWorkspaceDir(ctx.config as Record<string, unknown>);
    if (!workspaceDir) {
      if (isBootstrapCandidate(content)) {
        await sendTelegramText(ctx, conversationId, "Nao encontrei o workspace da Fabrica configurado no OpenClaw.");
      }
      return;
    }

    // Layer 1: Active clarifying OR classifying session?
    const existingSession = await readTelegramBootstrapSession(workspaceDir, conversationId);
    // If the clarifying session has expired, treat any new bootstrap candidate as a fresh request
    const sessionIsExpired = existingSession != null && Date.parse(existingSession.suppressUntil) < Date.now();
    if (existingSession && !sessionIsExpired && existingSession.status === "classifying") {
      // LLM classification is in progress — suppress duplicate messages
      ctx.logger.info(`[telegram-bootstrap] LLM classification in progress for ${conversationId}, ignoring concurrent message`);
      return;
    }
    if (existingSession?.status === "clarifying" && !sessionIsExpired) {
      const clarResult = parseClarificationResponse(content, existingSession);
      if (!clarResult.recognized) {
        // Re-ask — don't let the regular agent respond to this message either
        ctx.logger.info(`[telegram-bootstrap] clarification response not recognized, re-asking (conversation: ${conversationId})`);
        await sendTelegramText(ctx, conversationId, buildFollowUpClarification(existingSession));
        return;
      }
      // Merge clarification into existing session, preserving rawIdea
      const mergedRequest = {
        rawIdea: existingSession.rawIdea,
        projectName: clarResult.projectName ?? existingSession.projectName ?? null,
        stackHint: clarResult.stackHint ?? existingSession.stackHint ?? null,
        repoUrl: existingSession.repoUrl ?? null,
        repoPath: existingSession.repoPath ?? null,
      };
      ctx.logger.info(`[telegram-bootstrap] clarification resolved: stack=${mergedRequest.stackHint}, idea="${mergedRequest.rawIdea}" (conversation: ${conversationId})`);
      // Continue with merged request — fall through with pre-populated data
      // Fire-and-forget: session suppression is already in place (suppressUntil set above).
      // Awaiting the full pipeline in the event handler blocks all Telegram message processing.
      continueBootstrap(ctx, conversationId, workspaceDir, mergedRequest, existingSession.sourceRoute ?? {
        channel: "telegram",
        channelId: conversationId,
      }).catch((err) => {
        logBootstrapWarning(ctx, `[telegram-bootstrap] unhandled pipeline error: ${err instanceof Error ? err.message : String(err)}`);
      });
      return;
    }

    if (!isBootstrapCandidate(content)) {
      // Layer 3: LLM for ambiguous cases (fire-and-forget)
      if (isAmbiguousCandidate(content)) {
        // Create session with "classifying" status to suppress agent response for this turn
        await upsertTelegramBootstrapSession(workspaceDir, {
          conversationId,
          rawIdea: content,
          sourceRoute: { channel: "telegram", channelId: conversationId },
          status: "classifying",
        });

        // Fire-and-forget: LLM classify + bootstrap runs detached from event handler
        classifyAndBootstrap(ctx, workspaceDir, conversationId, content).catch((err) => {
          logBootstrapWarning(ctx, `[telegram-bootstrap] LLM classify error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      return;
    }

    const parsed = parseBootstrapRequest(content);

    const incomingRequest = {
      rawIdea: parsed.rawIdea,
      projectName: parsed.projectName ?? null,
      stackHint: parsed.stackHint ?? null,
      repoUrl: parsed.repoUrl ?? null,
      repoPath: parsed.repoPath ?? null,
    };
    const incomingRequestHash = buildBootstrapRequestHash(incomingRequest);
    const sessionForHash = await readTelegramBootstrapSession(workspaceDir, conversationId);
    if (sessionForHash?.requestHash === incomingRequestHash) {
      if (sessionForHash.status === "completed") {
        ctx.logger.info(`[telegram-bootstrap] duplicate completed DM ignored for conversation ${conversationId}`);
        return;
      }
      // Allow restart if pipeline is stuck in "received" with an expired suppress window.
      // This happens when the gateway restarts mid-pipeline (session never reached "failed").
      const isExpiredReceived =
        sessionForHash.status === "received" &&
        Date.parse(sessionForHash.suppressUntil) < Date.now();
      // Note: unlike Layer 3, this guard intentionally does NOT exclude "classifying" status.
      // If a "classifying" session has a matching hash and is still active, Layer 2 is correctly
      // blocked — this avoids double-firing during the LLM classification window.
      if (sessionForHash.status !== "failed" && !isExpiredReceived) {
        ctx.logger.info(`[telegram-bootstrap] duplicate in-flight DM ignored for conversation ${conversationId}`);
        return;
      }
      if (isExpiredReceived) {
        ctx.logger.info(`[telegram-bootstrap] stale received session (expired) — restarting pipeline for conversation ${conversationId}`);
      }
    }

    // Immediate ack — user knows message was received before pipeline starts
    await sendTelegramText(ctx, conversationId, "Recebi! Vou analisar e começar a montar o projeto...");

    const session = await upsertTelegramBootstrapSession(workspaceDir, {
      conversationId,
      ...incomingRequest,
      sourceRoute: {
        channel: "telegram",
        channelId: conversationId,
      },
      sourceChannel: "telegram",
      status: "received",
    });

    if (!parsed.stackHint) {
      const pendingClarification = !parsed.projectName ? "stack_and_name" as const : "stack" as const;
      await upsertTelegramBootstrapSession(workspaceDir, {
        conversationId,
        ...incomingRequest,
        sourceRoute: session.sourceRoute,
        status: "clarifying",
        pendingClarification,
      });
      await sendTelegramText(ctx, conversationId, buildClarificationMessage(parsed, pendingClarification));
      return;
    }

    // Fire-and-forget: session suppression is already in place (suppressUntil set above).
    // Awaiting the full pipeline in the event handler blocks all Telegram message processing.
    continueBootstrap(ctx, conversationId, workspaceDir, incomingRequest, {
      channel: "telegram",
      channelId: conversationId,
    }).catch((err) => {
      logBootstrapWarning(ctx, `[telegram-bootstrap] unhandled pipeline error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
}
