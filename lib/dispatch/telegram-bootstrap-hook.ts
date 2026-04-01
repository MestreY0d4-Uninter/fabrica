import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginContext } from "../context.js";
import { resolveWorkspaceDir } from "./attachment-hook.js";
import { hasGenesisAgent } from "../setup/agent.js";
import { runPipeline, type GenesisPayload, type StepContext } from "../intake/index.js";
import { createProvider } from "../providers/index.js";
import { readFabricaTelegramConfig } from "../telegram/config.js";
import { readProjects } from "../projects/index.js";
import { discoverAgents } from "../services/heartbeat/agent-discovery.js";
import { projectTick } from "../services/tick.js";
import { z } from "zod";
import {
  buildBootstrapRequestHash,
  deleteTelegramBootstrapSession,
  readTelegramBootstrapSession,
  shouldSuppressTelegramBootstrapReply,
  upsertTelegramBootstrapSession,
  type TelegramBootstrapSession,
  type TelegramBootstrapStep,
} from "./telegram-bootstrap-session.js";
import { DATA_DIR } from "../setup/constants.js";
const BOOTSTRAP_RETRY_DELAY_MS = 15_000;
const LAYER3_CONFIDENCE_THRESHOLD = 0.6;
const activeBootstrapResumes = new Set<string>();

type BootstrapRequest = {
  rawIdea: string;
  projectName?: string | null;
  repoUrl?: string | null;
  repoPath?: string | null;
  stackHint?: string | null;
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
  clarifyName: {
    pt: "Como você quer chamar o projeto? Se preferir, posso escolher um nome.",
    en: "What do you want to name the project? If you prefer, I can pick one.",
  },
  registered: {
    pt: (name: string, link: string) => `Projeto "${name}" registrado.\nVou continuar o fluxo em ${link}`,
    en: (name: string, link: string) => `Project "${name}" registered.\nI'll continue the flow at ${link}`,
  },
} as const;

function inferProjectSlug(text: string): string | undefined {
  let cleaned = text
    .replace(/^(create|build|crie|cria|criar|fazer?|quero|i need|i want)\s+(uma|um|me\s+a?|an|a)?\s*/i, "")
    .replace(/\s+(that|which|que|para|for|pra)\s+.*/i, "")
    .trim();
  if (!cleaned) cleaned = text;

  const slug = cleaned
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

function normalizeUserResponse(text: string): string {
  return text.trim().replace(/[.,!?;:\u2026]+$/, "").toLowerCase();
}

function detectStackHint(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (/\b(nextjs|next\.js)\b/.test(lower)) return "nextjs";
  if (/\bnode\.?js\b/.test(lower)) return "node-cli";
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
  _workspaceDir: string,
): Promise<DmIntentClassification | null> {
  try {
    const runtime = ctx.runtime;
    if (!runtime?.subagent?.run) return null;

    const truncated = content.slice(0, MAX_CLASSIFY_LENGTH);
    const prompt = CLASSIFY_PROMPT_TEMPLATE.replace("$CONTENT", truncated.replace(/"/g, '\\"'));
    const sessionKey = `dm-classify-${Date.now()}`;

    const { runId } = await runtime.subagent.run({
      sessionKey,
      message: prompt,
      extraSystemPrompt: "You are a JSON classifier. Return ONLY valid JSON, no markdown fences.",
      lane: "subagent",
      deliver: false,
      idempotencyKey: sessionKey,
    });

    const waitResult = await runtime.subagent.waitForRun({ runId, timeoutMs: 15_000 });
    if (waitResult.status !== "ok") {
      ctx.logger.warn(`[telegram-bootstrap] classify waitForRun status=${waitResult.status} (expected ok)`);
      return null;
    }

    const messagesResult = await runtime.subagent.getSessionMessages({ sessionKey });
    // getSessionMessages may return an array or an object with a messages property
    const messages = Array.isArray(messagesResult)
      ? messagesResult
      : (Array.isArray((messagesResult as any)?.messages) ? (messagesResult as any).messages : []);
    const lastAssistant = messages.filter((m: any) => m.role === "assistant").pop();
    if (!lastAssistant) {
      ctx.logger.warn(`[telegram-bootstrap] classify: no assistant message found (messages=${messages.length}, resultType=${typeof messagesResult})`);
      return null;
    }
    // content may be a string or an array of content blocks (thinking + text)
    const rawContent = lastAssistant.content;
    const text = typeof rawContent === "string"
      ? rawContent
      : (Array.isArray(rawContent)
        ? (rawContent.find((b: any) => b.type === "text")?.text ?? "")
        : "");
    if (!text.trim()) {
      ctx.logger.warn(`[telegram-bootstrap] classify: empty text from assistant (contentType=${typeof rawContent}, isArray=${Array.isArray(rawContent)})`);
      return null;
    }

    const jsonStr = text.replace(/^```(json)?/gm, "").replace(/```$/gm, "").trim();
    const intentData = JSON.parse(jsonStr);
    const validated = DmIntentSchema.safeParse(intentData);
    if (!validated.success) {
      ctx.logger.warn(`[telegram-bootstrap] classify: schema validation failed: ${validated.error?.message}`);
    }
    return validated.success ? validated.data : null;
  } catch (err) {
    ctx.logger.warn(`[telegram-bootstrap] classify exception: ${(err as Error).message ?? err}`);
    return null;
  }
}

function resetActiveBootstrapResumesForTests(): void {
  activeBootstrapResumes.clear();
}

export { isAmbiguousCandidate as _testIsAmbiguousCandidate, classifyDmIntent as _testClassifyDmIntent, buildTopicDeepLink as _testBuildTopicDeepLink, inferProjectSlug as _testInferProjectSlug, normalizeUserResponse as _testNormalizeUserResponse, continueBootstrap as _testContinueBootstrap, recoverDueTelegramBootstrapSessions as _testRecoverDueBootstraps, resumeBootstrapping as _testResumeBootstrapping, resetActiveBootstrapResumesForTests as _testResetActiveBootstrapResumes };

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
  // When asking for project name only, treat response as project name
  if (session.pendingClarification === "name") {
    const trimmed = text.trim();
    const autoPatterns = /^(escolha|pick one|tanto faz|you choose|pode escolher|auto|skip)$/i;
    if (autoPatterns.test(normalizeUserResponse(text))) {
      // User wants auto-generation — derive slug from rawIdea, fallback to timestamp slug
      return { recognized: true, projectName: inferProjectSlug(session.rawIdea) ?? `project-${Date.now()}`, stackHint: session.stackHint ?? undefined };
    }
    const nameField = parseField(text, ["project name", "nome do projeto", "nome", "name"]);
    if (nameField) {
      return { recognized: true, projectName: nameField, stackHint: session.stackHint ?? undefined };
    }
    if (trimmed.length > 0 && trimmed.length <= 64) {
      return { recognized: true, projectName: trimmed, stackHint: session.stackHint ?? undefined };
    }
    return { recognized: false };
  }

  // Try structured field format first (e.g. "Stack: python-cli")
  const stackField = parseField(text, ["stack", "framework", "linguagem", "language"]);
  if (stackField) {
    return { recognized: true, stackHint: detectStackHint(stackField) ?? stackField };
  }
  // Try direct stack hint detection on the whole message
  const detectedStack = detectStackHint(text);
  if (detectedStack) {
    // Also try to extract inline project name (e.g. "Node.js, name it disk-usage-cli")
    const projectNameFromField = parseField(text, ["project name", "nome do projeto", "nome", "name"]);
    const nameItMatch = !projectNameFromField ? text.match(/(?:name|call|chamar?)\s+(?:it\s+)?([\w-]{2,64})/i) : null;
    const inlineName = projectNameFromField ?? (nameItMatch ? (nameItMatch[1].toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-") || undefined) : undefined);
    return { recognized: true, stackHint: detectedStack, projectName: inlineName };
  }
  // Detect bare language names as stack hints
  const lower = normalizeUserResponse(text);
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

function buildClarificationMessage(parsed: BootstrapRequest, pendingClarification?: "stack" | "stack_and_name" | "name", language: BootstrapLanguage = "pt"): string {
  if (pendingClarification === "name") {
    return BOOTSTRAP_MESSAGES.clarifyName[language];
  }
  if (pendingClarification === "stack_and_name" || (!parsed.stackHint && !parsed.projectName)) {
    return BOOTSTRAP_MESSAGES.clarifyBoth[language];
  }
  return BOOTSTRAP_MESSAGES.clarifyStack[language];
}

function buildTopicDeepLink(chatId: string, topicId: number): string {
  const stripped = chatId.replace(/^-100/, "");
  return `https://t.me/c/${stripped}/${topicId}`;
}

function buildDmAck(projectName: string, topicLink: string, language: BootstrapLanguage = "pt"): string {
  return BOOTSTRAP_MESSAGES.registered[language](projectName, topicLink);
}

function buildTopicKickoff(projectName: string, idea: string, language: BootstrapLanguage = "pt"): string {
  const header = language === "en"
    ? `🧱 Project automatically registered by Fabrica.\nProject: ${projectName}\n\nOriginal request summary:`
    : `🧱 Projeto registrado automaticamente pela Fabrica.\nProjeto: ${projectName}\n\nResumo do pedido inicial:`;
  return `${header}\n${idea}`;
}

function normalizeTelegramChatTarget(target: string): string {
  return target.startsWith("telegram:") ? target.slice("telegram:".length) : target;
}

function isRecoverableTelegramRuntimeSendError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Cannot read properties of undefined|is not a function|runtime unavailable/i.test(message);
}

async function sendTelegramText(
  ctx: PluginContext,
  target: string,
  message: string,
  opts?: { accountId?: string; messageThreadId?: number },
): Promise<void> {
  const normalizedTarget = normalizeTelegramChatTarget(target);
  const sendOpts: Record<string, unknown> = {
    silent: true,
    disableWebPagePreview: true,
  };
  if (opts?.accountId) sendOpts.accountId = opts.accountId;
  if (opts?.messageThreadId != null) sendOpts.messageThreadId = opts.messageThreadId;

  const telegramChannel = (ctx.runtime as any)?.channel?.telegram as
    | { sendMessageTelegram?: (to: string, text: string, options?: Record<string, unknown>) => Promise<unknown> }
    | undefined;

  if (telegramChannel?.sendMessageTelegram) {
    try {
      await telegramChannel.sendMessageTelegram(normalizedTarget, message, sendOpts);
      return;
    } catch (error) {
      if (!isRecoverableTelegramRuntimeSendError(error)) {
        throw error;
      }
      logBootstrapWarning(
        ctx,
        `[telegram-bootstrap] Telegram runtime send failed, falling back to CLI delivery: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const cliArgs = [
    "openclaw",
    "message",
    "send",
    "--channel",
    "telegram",
    "--target",
    normalizedTarget,
    "--message",
    message,
    "--json",
  ];
  if (opts?.accountId) {
    cliArgs.push("--account", opts.accountId);
  }
  if (opts?.messageThreadId != null) {
    cliArgs.push("--thread-id", String(opts.messageThreadId));
  }
  await ctx.runCommand(cliArgs, { timeoutMs: 30_000 });
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

function buildBootstrapRequestFromSession(session: TelegramBootstrapSession): BootstrapRequest {
  return {
    rawIdea: session.rawIdea,
    projectName: session.projectName ?? undefined,
    repoUrl: session.repoUrl ?? undefined,
    repoPath: session.repoPath ?? undefined,
    stackHint: session.stackHint ?? undefined,
  };
}

function buildSessionSourceRoute(session: TelegramBootstrapSession): TelegramBootstrapRoute {
  return session.sourceRoute ?? {
    channel: "telegram",
    channelId: normalizeTelegramChatTarget(session.conversationId),
  };
}

function buildProjectRoute(session: TelegramBootstrapSession): TelegramBootstrapRoute | null {
  if (session.projectRoute) return session.projectRoute;

  if (!session.projectChannelId || session.messageThreadId == null) {
    return null;
  }

  return {
    channel: "telegram",
    channelId: session.projectChannelId,
    messageThreadId: session.messageThreadId,
  };
}

type RecoverableBootstrapSession = TelegramBootstrapSession & {
  status: "bootstrapping" | "dispatching";
};

type BootstrapAttemptOwner = {
  conversationId: string;
  attemptId: string;
  attemptSeq: number;
};

function isRecoverableBootstrapSession(session: TelegramBootstrapSession | null | undefined): session is RecoverableBootstrapSession {
  return session?.status === "bootstrapping" || session?.status === "dispatching";
}

function shouldResumeBootstrapNow(session: TelegramBootstrapSession): boolean {
  if (!session.nextRetryAt) return true;
  const retryAt = Date.parse(session.nextRetryAt);
  return Number.isNaN(retryAt) || retryAt <= Date.now();
}

function freshBootstrapResetFields(request: BootstrapRequest): {
  projectRoute: null;
  projectSlug: string | null;
  issueId: null;
  bootstrapStep: null;
  attemptCount: number;
  pendingClarification: null;
  messageThreadId: null;
  projectChannelId: null;
  lastError: null;
  nextRetryAt: null;
  ackSentAt: null;
  projectRegisteredAt: null;
  topicKickoffSentAt: null;
  projectTickedAt: null;
  completionAckSentAt: null;
} {
  return {
    projectRoute: null,
    projectSlug: request.projectName ?? null,
    issueId: null,
    bootstrapStep: null,
    attemptCount: 0,
    pendingClarification: null,
    messageThreadId: null,
    projectChannelId: null,
    lastError: null,
    nextRetryAt: null,
    ackSentAt: null,
    projectRegisteredAt: null,
    topicKickoffSentAt: null,
    projectTickedAt: null,
    completionAckSentAt: null,
  };
}

function createBootstrapAttemptOwner(
  existingSession: TelegramBootstrapSession | null,
): BootstrapAttemptOwner {
  return {
    attemptId: randomUUID(),
    attemptSeq: Math.max(existingSession?.attemptSeq ?? 0, 0) + 1,
    conversationId: existingSession?.conversationId ?? "",
  };
}

function buildBootstrapAttemptOwner(session: TelegramBootstrapSession | null | undefined): BootstrapAttemptOwner | null {
  if (!session.attemptId || session.attemptSeq == null) {
    return null;
  }
  return {
    conversationId: session.conversationId,
    attemptId: session.attemptId,
    attemptSeq: session.attemptSeq,
  };
}

function ownsBootstrapAttempt(
  session: TelegramBootstrapSession | null | undefined,
  owner: BootstrapAttemptOwner,
): boolean {
  return Boolean(
    session &&
    session.attemptId === owner.attemptId &&
    session.attemptSeq === owner.attemptSeq,
  );
}

async function readOwnedBootstrapSession(
  workspaceDir: string,
  owner: BootstrapAttemptOwner,
): Promise<TelegramBootstrapSession | null> {
  const latest = await readTelegramBootstrapSession(workspaceDir, owner.conversationId);
  if (!ownsBootstrapAttempt(latest, owner)) {
    return latest;
  }
  return latest;
}

async function persistOwnedBootstrapCheckpoint(
  workspaceDir: string,
  owner: BootstrapAttemptOwner,
  input: {
    rawIdea?: string;
    projectName?: string | null;
    stackHint?: string | null;
    repoUrl?: string | null;
    repoPath?: string | null;
    sourceRoute?: TelegramBootstrapRoute | null;
    projectRoute?: TelegramBootstrapRoute | null;
    status: TelegramBootstrapSession["status"];
    bootstrapStep?: TelegramBootstrapStep | null;
    projectSlug?: string | null;
    issueId?: number | null;
    messageThreadId?: number | null;
    projectChannelId?: string | null;
    language?: BootstrapLanguage;
    attemptCount?: number | null;
    lastError?: string | null;
    nextRetryAt?: string | null;
    ackSentAt?: string | null;
    projectRegisteredAt?: string | null;
    topicKickoffSentAt?: string | null;
    projectTickedAt?: string | null;
    completionAckSentAt?: string | null;
    pendingClarification?: "stack" | "stack_and_name" | "name" | null;
    error?: string | null;
  },
): Promise<TelegramBootstrapSession | null> {
  const latest = await readTelegramBootstrapSession(workspaceDir, owner.conversationId);
  if (!ownsBootstrapAttempt(latest, owner)) {
    return latest;
  }
  if (!latest) {
    return null;
  }

  return upsertTelegramBootstrapSession(workspaceDir, {
    conversationId: owner.conversationId,
    rawIdea: input.rawIdea ?? latest.rawIdea,
    projectName: input.projectName,
    stackHint: input.stackHint,
    repoUrl: input.repoUrl,
    repoPath: input.repoPath,
    sourceRoute: input.sourceRoute,
    projectRoute: input.projectRoute,
    status: input.status,
    bootstrapStep: input.bootstrapStep,
    projectSlug: input.projectSlug ?? undefined,
    issueId: input.issueId,
    messageThreadId: input.messageThreadId,
    projectChannelId: input.projectChannelId,
    language: input.language,
    attemptId: owner.attemptId,
    attemptSeq: owner.attemptSeq,
    attemptCount: input.attemptCount,
    lastError: input.lastError,
    nextRetryAt: input.nextRetryAt,
    ackSentAt: input.ackSentAt,
    projectRegisteredAt: input.projectRegisteredAt,
    topicKickoffSentAt: input.topicKickoffSentAt,
    projectTickedAt: input.projectTickedAt,
    completionAckSentAt: input.completionAckSentAt,
    pendingClarification: input.pendingClarification,
    error: input.error,
  });
}

async function enterBootstrapping(
  workspaceDir: string,
  conversationId: string,
  request: BootstrapRequest,
  sourceRoute: TelegramBootstrapRoute,
  language: BootstrapLanguage,
  options?: {
    ackSentAt?: string | null;
  },
): Promise<TelegramBootstrapSession> {
  const existingSession = await readTelegramBootstrapSession(workspaceDir, conversationId);
  const owner = createBootstrapAttemptOwner(existingSession);
  owner.conversationId = conversationId;
  return upsertTelegramBootstrapSession(workspaceDir, {
    conversationId,
    rawIdea: request.rawIdea,
    projectName: request.projectName ?? null,
    stackHint: request.stackHint ?? null,
    repoUrl: request.repoUrl ?? null,
    repoPath: request.repoPath ?? null,
    sourceRoute,
    sourceChannel: "telegram",
    status: "bootstrapping",
    language,
    attemptId: owner.attemptId,
    attemptSeq: owner.attemptSeq,
    ...freshBootstrapResetFields(request),
    bootstrapStep: options?.ackSentAt ? "awaiting_pipeline" : "awaiting_ack",
    ackSentAt: options?.ackSentAt ?? null,
  });
}

async function recordBootstrapRetry(
  workspaceDir: string,
  session: TelegramBootstrapSession,
  error: unknown,
): Promise<TelegramBootstrapSession> {
  const message = error instanceof Error ? error.message : String(error);
  const owner = buildBootstrapAttemptOwner(session);
  if (!owner) {
    return upsertTelegramBootstrapSession(workspaceDir, {
      conversationId: session.conversationId,
      rawIdea: session.rawIdea,
      status: session.status === "dispatching" || session.projectRegisteredAt ? "dispatching" : "bootstrapping",
      attemptCount: (session.attemptCount ?? 0) + 1,
      lastError: message,
      nextRetryAt: new Date(Date.now() + BOOTSTRAP_RETRY_DELAY_MS).toISOString(),
      language: session.language,
    });
  }

  return await persistOwnedBootstrapCheckpoint(workspaceDir, owner, {
    rawIdea: session.rawIdea,
    projectName: session.projectName ?? undefined,
    stackHint: session.stackHint ?? undefined,
    repoUrl: session.repoUrl ?? undefined,
    repoPath: session.repoPath ?? undefined,
    sourceRoute: buildSessionSourceRoute(session),
    projectRoute: buildProjectRoute(session),
    status: session.status === "dispatching" || session.projectRegisteredAt ? "dispatching" : "bootstrapping",
    bootstrapStep: session.bootstrapStep ?? (session.projectRegisteredAt ? "project_registered" : "awaiting_ack"),
    projectSlug: session.projectSlug ?? undefined,
    messageThreadId: session.messageThreadId,
    projectChannelId: session.projectChannelId,
    language: session.language,
    attemptCount: (session.attemptCount ?? 0) + 1,
    lastError: message,
    nextRetryAt: new Date(Date.now() + BOOTSTRAP_RETRY_DELAY_MS).toISOString(),
    ackSentAt: session.ackSentAt ?? null,
    projectRegisteredAt: session.projectRegisteredAt ?? null,
    topicKickoffSentAt: session.topicKickoffSentAt ?? null,
    projectTickedAt: session.projectTickedAt ?? null,
    completionAckSentAt: session.completionAckSentAt ?? null,
  }) ?? session;
}

async function leaseBootstrapRecovery(
  workspaceDir: string,
  session: TelegramBootstrapSession,
): Promise<TelegramBootstrapSession> {
  const owner = buildBootstrapAttemptOwner(session) ?? {
    ...createBootstrapAttemptOwner(session),
    conversationId: session.conversationId,
  };
  return upsertTelegramBootstrapSession(workspaceDir, {
    conversationId: session.conversationId,
    rawIdea: session.rawIdea,
    status: session.status,
    bootstrapStep: session.bootstrapStep ?? (session.projectRegisteredAt ? "project_registered" : "awaiting_ack"),
    attemptId: owner.attemptId,
    attemptSeq: owner.attemptSeq,
    nextRetryAt: new Date(Date.now() + BOOTSTRAP_RETRY_DELAY_MS).toISOString(),
    lastError: session.lastError ?? null,
    language: session.language,
  });
}

function startFreshBootstrapResume(
  ctx: PluginContext,
  workspaceDir: string,
  conversationId: string,
  start: () => Promise<TelegramBootstrapSession>,
): Promise<TelegramBootstrapSession> | null {
  if (activeBootstrapResumes.has(conversationId)) {
    return null;
  }

  activeBootstrapResumes.add(conversationId);
  const resumePromise = (async () => {
    const session = await start();
    return await resumeBootstrappingSession(ctx, workspaceDir, session);
  })().finally(() => {
    activeBootstrapResumes.delete(conversationId);
  });
  return resumePromise;
}

async function persistDispatchProgress(
  workspaceDir: string,
  session: TelegramBootstrapSession,
  input: {
    projectRoute?: TelegramBootstrapRoute | null;
    projectChannelId?: string | null;
    messageThreadId?: number | null;
    topicKickoffSentAt?: string | null;
    projectTickedAt?: string | null;
    completionAckSentAt?: string | null;
    bootstrapStep: TelegramBootstrapStep;
  },
): Promise<TelegramBootstrapSession> {
  const owner = buildBootstrapAttemptOwner(session);
  if (!owner) {
    return upsertTelegramBootstrapSession(workspaceDir, {
      conversationId: session.conversationId,
      rawIdea: session.rawIdea,
      projectName: session.projectName ?? undefined,
      stackHint: session.stackHint ?? undefined,
      repoUrl: session.repoUrl ?? undefined,
      repoPath: session.repoPath ?? undefined,
      sourceRoute: buildSessionSourceRoute(session),
      status: "dispatching",
      bootstrapStep: input.bootstrapStep,
      projectSlug: session.projectSlug ?? undefined,
      projectRoute: input.projectRoute,
      projectChannelId: input.projectChannelId,
      messageThreadId: input.messageThreadId,
      projectRegisteredAt: session.projectRegisteredAt,
      topicKickoffSentAt: input.topicKickoffSentAt,
      projectTickedAt: input.projectTickedAt,
      completionAckSentAt: input.completionAckSentAt,
      lastError: null,
      nextRetryAt: null,
      language: session.language,
    });
  }

  return await persistOwnedBootstrapCheckpoint(workspaceDir, owner, {
    rawIdea: session.rawIdea,
    projectName: session.projectName ?? undefined,
    stackHint: session.stackHint ?? undefined,
    repoUrl: session.repoUrl ?? undefined,
    repoPath: session.repoPath ?? undefined,
    sourceRoute: buildSessionSourceRoute(session),
    status: "dispatching",
    bootstrapStep: input.bootstrapStep,
    projectSlug: session.projectSlug ?? undefined,
    projectRoute: input.projectRoute,
    projectChannelId: input.projectChannelId,
    messageThreadId: input.messageThreadId,
    projectRegisteredAt: session.projectRegisteredAt,
    topicKickoffSentAt: input.topicKickoffSentAt,
    projectTickedAt: input.projectTickedAt,
    completionAckSentAt: input.completionAckSentAt,
    lastError: null,
    nextRetryAt: null,
    language: session.language,
    ackSentAt: session.ackSentAt ?? null,
  }) ?? session;
}

async function runBootstrapHandoff(
  ctx: PluginContext,
  workspaceDir: string,
  session: TelegramBootstrapSession,
): Promise<TelegramBootstrapSession> {
  const owner = buildBootstrapAttemptOwner(session);
  if (!owner) {
    return session;
  }

  const currentSession = await readOwnedBootstrapSession(workspaceDir, owner);
  if (!ownsBootstrapAttempt(currentSession, owner)) {
    return currentSession ?? session;
  }
  session = currentSession as TelegramBootstrapSession;

  if (!session.ackSentAt) {
    await sendTelegramText(
      ctx,
      session.conversationId,
      BOOTSTRAP_MESSAGES.ack[session.language ?? "pt"],
    );
    session = await persistOwnedBootstrapCheckpoint(workspaceDir, owner, {
      rawIdea: session.rawIdea,
      projectName: session.projectName ?? undefined,
      stackHint: session.stackHint ?? undefined,
      repoUrl: session.repoUrl ?? undefined,
      repoPath: session.repoPath ?? undefined,
      sourceRoute: buildSessionSourceRoute(session),
      status: "bootstrapping",
      bootstrapStep: "awaiting_pipeline",
      projectSlug: session.projectSlug ?? undefined,
      projectRoute: buildProjectRoute(session),
      projectChannelId: session.projectChannelId,
      messageThreadId: session.messageThreadId,
      language: session.language,
      ackSentAt: new Date().toISOString(),
      projectRegisteredAt: session.projectRegisteredAt ?? null,
      topicKickoffSentAt: session.topicKickoffSentAt ?? null,
      projectTickedAt: session.projectTickedAt ?? null,
      completionAckSentAt: session.completionAckSentAt ?? null,
      lastError: null,
      nextRetryAt: null,
    }) ?? session;
    if (!ownsBootstrapAttempt(session, owner)) {
      return session;
    }
  }

  if (session.projectRegisteredAt) {
    return completeRegisteredBootstrap(ctx, workspaceDir, session);
  }

  await continueBootstrap(
    ctx,
    session.conversationId,
    workspaceDir,
    buildBootstrapRequestFromSession(session),
    buildSessionSourceRoute(session),
  );

  return await readTelegramBootstrapSession(workspaceDir, session.conversationId) ?? session;
}

async function completeRegisteredBootstrap(
  ctx: PluginContext,
  workspaceDir: string,
  session: TelegramBootstrapSession,
): Promise<TelegramBootstrapSession> {
  const owner = buildBootstrapAttemptOwner(session);
  if (!owner) {
    return session;
  }

  const currentSession = await readOwnedBootstrapSession(workspaceDir, owner);
  if (!ownsBootstrapAttempt(currentSession, owner)) {
    return currentSession ?? session;
  }
  session = currentSession as TelegramBootstrapSession;

  const projectRoute = buildProjectRoute(session);
  const projectChannelId = projectRoute?.channelId;
  const messageThreadId = projectRoute?.messageThreadId;

  if (!projectChannelId || messageThreadId == null) {
    const resolvedProjectName = session.projectName ?? session.projectSlug ?? "projeto";
    logBootstrapWarning(ctx, `[telegram-bootstrap] projectRegisteredAt checkpoint missing topic route for "${resolvedProjectName}"`);
    await persistOwnedBootstrapCheckpoint(workspaceDir, owner, {
      rawIdea: session.rawIdea,
      projectName: session.projectName ?? undefined,
      stackHint: session.stackHint ?? undefined,
      repoUrl: session.repoUrl ?? undefined,
      repoPath: session.repoPath ?? undefined,
      sourceRoute: buildSessionSourceRoute(session),
      status: "failed",
      bootstrapStep: session.bootstrapStep ?? "project_registered",
      projectSlug: session.projectSlug ?? undefined,
      language: session.language,
      error: "missing_telegram_topic",
      ackSentAt: session.ackSentAt ?? null,
      projectRegisteredAt: session.projectRegisteredAt ?? null,
      topicKickoffSentAt: session.topicKickoffSentAt ?? null,
      projectTickedAt: session.projectTickedAt ?? null,
      completionAckSentAt: session.completionAckSentAt ?? null,
    });
    await sendTelegramText(
      ctx,
      session.conversationId,
      `Nao consegui concluir o bootstrap do projeto "${resolvedProjectName}" porque faltou a associacao obrigatoria com um topico Telegram. O projeto nao foi considerado registrado para o fluxo automatico.`,
    );
    return await readTelegramBootstrapSession(workspaceDir, session.conversationId) ?? session;
  }

  const resolvedProjectName = session.projectName ?? session.projectSlug ?? "projeto";
  const sessionLang: BootstrapLanguage = session.language ?? "pt";

  if (!session.topicKickoffSentAt) {
    await sendTelegramText(ctx, projectChannelId, buildTopicKickoff(resolvedProjectName, session.rawIdea, sessionLang), {
      accountId: projectRoute.accountId ?? undefined,
      messageThreadId,
    });
    session = await persistDispatchProgress(workspaceDir, session, {
      projectRoute,
      projectChannelId,
      messageThreadId,
      bootstrapStep: "topic_kickoff_sent",
      topicKickoffSentAt: new Date().toISOString(),
      projectTickedAt: session.projectTickedAt ?? null,
      completionAckSentAt: session.completionAckSentAt ?? null,
    });
  }

  const agents = discoverAgents(ctx.config);
  const primaryAgent = agents[0];
  if (!session.projectTickedAt && session.projectSlug && primaryAgent) {
    try {
      await projectTick({
        workspaceDir: primaryAgent.workspace,
        projectSlug: session.projectSlug,
        agentId: primaryAgent.agentId,
        pluginConfig: ctx.pluginConfig,
        runtime: ctx.runtime,
        runCommand: ctx.runCommand,
        maxPickups: 1,
      });
    } catch (error) {
      logBootstrapWarning(ctx, `[telegram-bootstrap] immediate projectTick failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    session = await persistDispatchProgress(workspaceDir, session, {
      projectRoute,
      projectChannelId,
      messageThreadId,
      bootstrapStep: "project_ticked",
      topicKickoffSentAt: session.topicKickoffSentAt ?? null,
      projectTickedAt: new Date().toISOString(),
      completionAckSentAt: session.completionAckSentAt ?? null,
    });
  }

  if (!session.completionAckSentAt) {
    await sendTelegramText(
      ctx,
      session.conversationId,
      buildDmAck(resolvedProjectName, buildTopicDeepLink(String(projectChannelId), messageThreadId), sessionLang),
    );
    session = await persistDispatchProgress(workspaceDir, session, {
      projectRoute,
      projectChannelId,
      messageThreadId,
      bootstrapStep: "completion_ack_sent",
      topicKickoffSentAt: session.topicKickoffSentAt ?? null,
      projectTickedAt: session.projectTickedAt ?? null,
      completionAckSentAt: new Date().toISOString(),
    });
  }

  const completedSession = await persistOwnedBootstrapCheckpoint(workspaceDir, owner, {
    rawIdea: session.rawIdea,
    projectName: resolvedProjectName,
    stackHint: session.stackHint ?? undefined,
    repoUrl: session.repoUrl ?? undefined,
    repoPath: session.repoPath ?? undefined,
    sourceRoute: buildSessionSourceRoute(session),
    status: "completed",
    bootstrapStep: "completed",
    projectSlug: session.projectSlug ?? undefined,
    projectRoute,
    projectChannelId,
    messageThreadId,
    lastError: null,
    nextRetryAt: null,
    projectRegisteredAt: session.projectRegisteredAt,
    topicKickoffSentAt: session.topicKickoffSentAt,
    projectTickedAt: session.projectTickedAt,
    completionAckSentAt: session.completionAckSentAt,
    language: session.language,
    ackSentAt: session.ackSentAt ?? null,
  });

  return completedSession ?? session;
}

async function resumeBootstrappingSession(
  ctx: PluginContext,
  workspaceDir: string,
  session: TelegramBootstrapSession,
): Promise<TelegramBootstrapSession> {
  try {
    return await runBootstrapHandoff(ctx, workspaceDir, session);
  } catch (error) {
    const latestSession = await readTelegramBootstrapSession(workspaceDir, session.conversationId) ?? session;
    if (latestSession.status === "failed" || latestSession.status === "completed") {
      return latestSession;
    }
    return await recordBootstrapRetry(workspaceDir, latestSession, error);
  }
}

async function resumeBootstrapping(
  ctx: PluginContext,
  workspaceDir: string,
  conversationId: string,
): Promise<TelegramBootstrapSession | null> {
  const session = await readTelegramBootstrapSession(workspaceDir, conversationId);
  if (!isRecoverableBootstrapSession(session)) return session;
  if (activeBootstrapResumes.has(conversationId)) return session;
  const leasedSession = await leaseBootstrapRecovery(workspaceDir, session);
  return resumeBootstrappingSession(ctx, workspaceDir, leasedSession);
}

export async function recoverDueTelegramBootstrapSessions(
  ctx: PluginContext,
  workspaceDir: string,
): Promise<number> {
  const sessionsDir = path.join(workspaceDir, DATA_DIR, "bootstrap-sessions");

  let files: string[];
  try {
    files = await fs.readdir(sessionsDir);
  } catch {
    return 0;
  }

  let resumedCount = 0;

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const conversationId = file.replace(/\.json$/, "");
    const session = await readTelegramBootstrapSession(workspaceDir, conversationId);
    if (!isRecoverableBootstrapSession(session)) continue;
    if (!shouldResumeBootstrapNow(session)) continue;
    if (activeBootstrapResumes.has(session.conversationId)) continue;

    const leasedSession = await leaseBootstrapRecovery(workspaceDir, session);
    activeBootstrapResumes.add(leasedSession.conversationId);
    try {
      await resumeBootstrappingSession(ctx, workspaceDir, leasedSession);
      resumedCount++;
    } finally {
      activeBootstrapResumes.delete(leasedSession.conversationId);
    }
  }

  return resumedCount;
}

async function runBootstrapPreflightOrFail(
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
  options?: {
    language?: BootstrapLanguage;
  },
): Promise<boolean> {
  const telegramConfig = readFabricaTelegramConfig(ctx.pluginConfig);
  const existingSession = await readTelegramBootstrapSession(workspaceDir, conversationId);
  const language = options?.language ?? existingSession?.language ?? "pt";

  if (!telegramConfig.projectsForumChatId) {
    await upsertTelegramBootstrapSession(workspaceDir, {
      conversationId,
      rawIdea: request.rawIdea,
      projectName: request.projectName ?? undefined,
      stackHint: request.stackHint ?? undefined,
      repoUrl: request.repoUrl ?? undefined,
      repoPath: request.repoPath ?? undefined,
      sourceRoute,
      status: "failed",
      language,
      error: "missing_projects_forum_chat",
    });
    await sendTelegramText(
      ctx,
      conversationId,
      "A Fabrica precisa de um grupo de projetos configurado para criar projetos automaticamente. " +
      "Configure 'telegram.projectsForumChatId' no openclaw.json do plugin.",
    );
    return true;
  }

  const candidateSlug = inferProjectSlug(request.projectName ?? request.rawIdea);
  if (!candidateSlug) return false;

  const projects = await readProjects(workspaceDir).catch(() => null);
  if (!projects?.projects?.[candidateSlug]) return false;

  await upsertTelegramBootstrapSession(workspaceDir, {
    conversationId,
    rawIdea: request.rawIdea,
    projectName: request.projectName ?? undefined,
    stackHint: request.stackHint ?? undefined,
    repoUrl: request.repoUrl ?? undefined,
    repoPath: request.repoPath ?? undefined,
    sourceRoute,
    status: "failed",
    projectSlug: candidateSlug,
    language,
    error: "duplicate_project_slug",
  });
  await sendTelegramText(
    ctx,
    conversationId,
    `Ja existe um projeto registrado com o slug "${candidateSlug}". Use o fluxo administrativo para vincular canais ou ajustar o projeto existente.`,
  );
  return true;
}

/**
 * Layer 3: LLM-based classification for ambiguous DMs.
 * Classifies the message via classifyDmIntent. If LLM returns null, "other", or
 * low confidence (< LAYER3_CONFIDENCE_THRESHOLD), deletes the classifying session (fail-open to chat).
 * If "create_project" with confidence >= LAYER3_CONFIDENCE_THRESHOLD (0.6), merges LLM enrichment,
 * runs deterministic preflight checks, then sends ack and enters clarification or fires the pipeline.
 */
async function classifyAndBootstrap(
  ctx: PluginContext,
  workspaceDir: string,
  conversationId: string,
  content: string,
): Promise<void> {
  // Transition from pending_classify → classifying (LLM call about to start)
  await upsertTelegramBootstrapSession(workspaceDir, {
    conversationId,
    rawIdea: content,
    sourceRoute: { channel: "telegram", channelId: conversationId },
    status: "classifying",
  });

  const classification = await classifyDmIntent(ctx, content, workspaceDir);

  // Fail-open: if LLM failed or returned "other" or low confidence, delete session so agent can respond
  if (!classification || classification.intent !== "create_project" || classification.confidence < LAYER3_CONFIDENCE_THRESHOLD) {
    if (!classification) {
      logBootstrapWarning(ctx, `[telegram-bootstrap] LLM classify failed, falling back (conversation: ${conversationId})`);
    }
    const latestSession = await readTelegramBootstrapSession(workspaceDir, conversationId);
    if (latestSession?.status === "classifying" || latestSession?.status === "pending_classify") {
      await deleteTelegramBootstrapSession(workspaceDir, conversationId);
    }
    return;
  }

  const language: BootstrapLanguage = classification.language ?? "pt";

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
  startFreshBootstrapResume(ctx, workspaceDir, conversationId, () => enterBootstrapping(
    workspaceDir,
    conversationId,
    incomingRequest,
    sourceRoute,
    language,
  ));
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
  if (await runBootstrapPreflightOrFail(ctx, conversationId, workspaceDir, request, sourceRoute)) {
    return;
  }
  const telegramConfig = readFabricaTelegramConfig(ctx.pluginConfig);

  const stackHint = request.stackHint;
  if (!stackHint) {
    // stackHint missing after clarification — redirect to stack clarification.
    const existingSession = await readTelegramBootstrapSession(workspaceDir, conversationId);
    const lang: BootstrapLanguage = existingSession?.language ?? "pt";
    const owner = buildBootstrapAttemptOwner(existingSession);
    if (owner) {
      await persistOwnedBootstrapCheckpoint(workspaceDir, owner, {
        rawIdea: request.rawIdea,
        projectName: request.projectName ?? undefined,
        stackHint: request.stackHint ?? undefined,
        sourceRoute,
        status: "clarifying",
        bootstrapStep: existingSession?.bootstrapStep ?? "awaiting_pipeline",
        pendingClarification: "stack",
        language: lang,
        ackSentAt: existingSession?.ackSentAt ?? null,
        lastError: null,
        nextRetryAt: null,
      });
    } else {
      await upsertTelegramBootstrapSession(workspaceDir, {
        conversationId,
        rawIdea: request.rawIdea,
        projectName: request.projectName ?? undefined,
        status: "clarifying",
        pendingClarification: "stack",
        language: lang,
      });
    }
    await sendTelegramText(ctx, conversationId, buildClarificationMessage(
      { rawIdea: request.rawIdea, projectName: request.projectName ?? undefined, stackHint: request.stackHint ?? undefined },
      "stack",
      lang,
    ));
    return;
  }

  // If stack known but name unknown, try fallbacks before asking
  if (!request.projectName) {
    // Fallback 1: try to derive slug from rawIdea silently
    const inferredSlug = inferProjectSlug(request.rawIdea);
    if (inferredSlug) {
      request.projectName = inferredSlug;
    } else {
      // Fallback 2: if already asked for name before, don't loop — generate timestamp slug
      const existingSession = await readTelegramBootstrapSession(workspaceDir, conversationId);
      if (existingSession?.pendingClarification === "name") {
        request.projectName = `project-${Date.now()}`;
      } else {
        // First time asking: enter clarification
        const lang: BootstrapLanguage = existingSession?.language ?? "pt";
        const owner = existingSession ? buildBootstrapAttemptOwner(existingSession) : null;
        if (owner) {
          await persistOwnedBootstrapCheckpoint(workspaceDir, owner, {
            rawIdea: request.rawIdea,
            stackHint: request.stackHint ?? undefined,
            sourceRoute,
            status: "clarifying",
            bootstrapStep: existingSession.bootstrapStep ?? "awaiting_pipeline",
            pendingClarification: "name",
            language: lang,
            ackSentAt: existingSession.ackSentAt ?? null,
            lastError: null,
            nextRetryAt: null,
          });
        } else {
          await upsertTelegramBootstrapSession(workspaceDir, {
            conversationId,
            rawIdea: request.rawIdea,
            stackHint: request.stackHint ?? undefined,
            status: "clarifying",
            pendingClarification: "name",
            language: lang,
          });
        }
        await sendTelegramText(
          ctx,
          conversationId,
          buildClarificationMessage(
            { rawIdea: request.rawIdea, projectName: undefined, stackHint: request.stackHint ?? undefined },
            "name",
            lang,
          ),
        );
        return;
      }
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
      project_name: request.projectName ?? null,
      repo_url: request.repoUrl ?? null,
      repo_path: request.repoPath ?? null,
      stack_hint: stackHint,
      channel_id: conversationId,
    },
  };

  // Re-read the current session for sourceRoute reference
  const currentSession = await readTelegramBootstrapSession(workspaceDir, conversationId);
  const currentOwner = currentSession ? buildBootstrapAttemptOwner(currentSession) : null;
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
    const projectRegistered = result.payload?.metadata?.project_registered === true;
    if (orphanedRepoArtifact && !projectRegistered) {
      if (currentOwner) {
        await persistOwnedBootstrapCheckpoint(workspaceDir, currentOwner, {
          ...incomingRequest,
          sourceRoute,
          status: "orphaned_repo",
          bootstrapStep: currentSession?.bootstrapStep ?? "awaiting_pipeline",
          projectSlug: result.payload?.metadata?.project_slug ?? undefined,
          error: result.error ?? "pipeline_failed_after_repo_creation",
          ackSentAt: currentSession?.ackSentAt ?? null,
        });
      } else {
        await upsertTelegramBootstrapSession(workspaceDir, {
          conversationId,
          ...incomingRequest,
          sourceRoute,
          status: "orphaned_repo",
          projectSlug: result.payload?.metadata?.project_slug ?? undefined,
          orphanedArtifacts: result.artifacts ?? [],
          error: result.error ?? "pipeline_failed_after_repo_creation",
        });
      }
      await sendTelegramText(
        ctx,
        conversationId,
        `O repositorio foi criado (${orphanedRepoArtifact.id}), mas o registro do projeto falhou.\n\nErro: ${result.error ?? "erro desconhecido"}\n\nVerifique o repositorio e registre o projeto manualmente se necessario.`,
      );
      return;
    }
    if (currentOwner) {
      await persistOwnedBootstrapCheckpoint(workspaceDir, currentOwner, {
        ...incomingRequest,
        sourceRoute,
        status: "failed",
        bootstrapStep: currentSession?.bootstrapStep ?? "awaiting_pipeline",
        projectSlug: result.payload?.metadata?.project_slug ?? undefined,
        error: result.error ?? "pipeline_failed",
        ackSentAt: currentSession?.ackSentAt ?? null,
      });
    } else {
      await upsertTelegramBootstrapSession(workspaceDir, {
        conversationId,
        ...incomingRequest,
        sourceRoute,
        status: "failed",
        projectSlug: result.payload?.metadata?.project_slug ?? undefined,
        error: result.error ?? "pipeline_failed",
      });
    }
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
    ?? request.projectName
    ?? "projeto";
  const projectChannelId = result.payload.metadata.channel_id ?? telegramConfig.projectsForumChatId;
  const messageThreadId = result.payload.metadata.message_thread_id;
  const projectSlug = result.payload.metadata.project_slug ?? result.payload.scaffold?.project_slug ?? null;

  if (projectChannelId && messageThreadId) {
    const projectRoute = {
      channel: "telegram",
      channelId: String(projectChannelId),
      messageThreadId,
      accountId: telegramConfig.projectsForumAccountId ?? undefined,
    };
    const registeredSession = currentOwner
      ? await persistOwnedBootstrapCheckpoint(workspaceDir, currentOwner, {
        ...incomingRequest,
        sourceRoute,
        status: "dispatching",
        bootstrapStep: "project_registered",
        projectName: resolvedProjectName,
        projectSlug: projectSlug ?? undefined,
        projectRegisteredAt: new Date().toISOString(),
        projectChannelId: String(projectChannelId),
        messageThreadId,
        projectRoute,
        lastError: null,
        nextRetryAt: null,
        language: currentSession?.language,
        ackSentAt: currentSession?.ackSentAt ?? null,
      })
      : await upsertTelegramBootstrapSession(workspaceDir, {
        conversationId,
        ...incomingRequest,
        sourceRoute,
        status: "dispatching",
        projectName: resolvedProjectName,
        projectSlug: projectSlug ?? undefined,
        projectRegisteredAt: new Date().toISOString(),
        projectChannelId: String(projectChannelId),
        messageThreadId,
        projectRoute,
      });
    if (!registeredSession) {
      return;
    }
    await completeRegisteredBootstrap(ctx, workspaceDir, {
      ...registeredSession,
      projectName: resolvedProjectName,
      projectSlug: projectSlug ?? registeredSession.projectSlug ?? undefined,
      projectRegisteredAt: registeredSession.projectRegisteredAt ?? new Date().toISOString(),
      language: (currentSession?.language ?? "pt"),
    });
    return;
  }

  logBootstrapWarning(ctx, `[telegram-bootstrap] pipeline completed without a project topic for "${resolvedProjectName}"`);
  if (currentOwner) {
    await persistOwnedBootstrapCheckpoint(workspaceDir, currentOwner, {
      ...incomingRequest,
      sourceRoute,
      status: "failed",
      bootstrapStep: currentSession?.bootstrapStep ?? "awaiting_pipeline",
      projectSlug: projectSlug ?? undefined,
      error: "missing_telegram_topic",
      ackSentAt: currentSession?.ackSentAt ?? null,
    });
  } else {
    await upsertTelegramBootstrapSession(workspaceDir, {
      conversationId,
      ...incomingRequest,
      sourceRoute,
      status: "failed",
      projectSlug: projectSlug ?? undefined,
      error: "missing_telegram_topic",
    });
  }
  await sendTelegramText(
    ctx,
    conversationId,
    `Nao consegui concluir o bootstrap do projeto "${resolvedProjectName}" porque faltou a associacao obrigatoria com um topico Telegram. O projeto nao foi considerado registrado para o fluxo automatico.`,
  );
}

export function registerTelegramBootstrapHook(api: OpenClawPluginApi, ctx: PluginContext): void {
  // When genesis agent exists, it handles DMs exclusively — main never receives them.
  // Suppress hooks (before_prompt_build + message_sending) are unnecessary in that case.
  const apiRuntime = (api as any).runtime;
  const hasGenesis = apiRuntime ? hasGenesisAgent(apiRuntime) : false;

  if (!hasGenesis) {
    api.on("before_prompt_build", async (_event, eventCtx) => {
    const hookCtx = eventCtx as { channelId?: string; sessionKey?: string };
    if (hookCtx.channelId !== "telegram") return {};
    // before_prompt_build receives PluginHookAgentContext which does NOT have conversationId.
    // Extract the Telegram chat ID from sessionKey (format: "agent:main:telegram:slash:<chatId>").
    // Group topics use "agent:main:telegram:group:<groupId>:topic:<topicId>" — skip those.
    const sessionKey = hookCtx.sessionKey ?? "";
    if (sessionKey.includes(":topic:") || sessionKey.includes(":group:")) return {};
    const sessionKeyParts = sessionKey.split(":");
    const chatId = sessionKeyParts.length >= 5 ? sessionKeyParts[sessionKeyParts.length - 1] : "";
    const conversationId = chatId ? `telegram:${chatId}` : "";
    if (!conversationId) return {};

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
  // Bootstrap sends use the Telegram runtime channel directly when available and fall back
  // to explicit CLI delivery otherwise, bypassing the agent-originated message pipeline.
  api.on("message_sending", async (event, eventCtx) => {
    const hookCtx = eventCtx as { channelId?: string };
    if (hookCtx.channelId !== "telegram") return;
    // message_sending receives PluginHookMessageContext which does NOT populate conversationId.
    // Use event.to (the outbound Telegram chat ID) to derive the conversationId.
    const sendEvent = event as { to?: string; content?: string; metadata?: Record<string, unknown> };
    const rawTo = String(sendEvent.to ?? "").trim();
    if (!rawTo || rawTo.startsWith("-")) return;
    // event.to is a bare chat ID (e.g. "6951571380") — convert to session key format
    const conversationId = rawTo.includes(":") ? rawTo : `telegram:${rawTo}`;
    if (conversationId.includes(":topic:")) return;

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
  } // end if (!hasGenesis)

  // When genesis agent exists, it handles DM bootstrapping exclusively —
  // do NOT process message_received here to avoid double-processing.
  if (hasGenesis) return;

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
    if (isRecoverableBootstrapSession(existingSession)) {
      if (shouldResumeBootstrapNow(existingSession)) {
        startFreshBootstrapResume(
          ctx,
          workspaceDir,
          existingSession.conversationId,
          () => leaseBootstrapRecovery(workspaceDir, existingSession),
        );
      } else {
        ctx.logger.info(`[telegram-bootstrap] recovery deferred until ${existingSession.nextRetryAt} for ${conversationId}`);
      }
      return;
    }
    // If the clarifying session has expired, treat any new bootstrap candidate as a fresh request
    const sessionIsExpired = existingSession != null && Date.parse(existingSession.suppressUntil) < Date.now();
    if (existingSession && !sessionIsExpired && (existingSession.status === "classifying" || existingSession.status === "pending_classify")) {
      // LLM classification is in progress (pending or active) — suppress duplicate messages
      ctx.logger.info(`[telegram-bootstrap] LLM classification in progress for ${conversationId}, ignoring concurrent message`);
      return;
    }
    if (existingSession?.status === "clarifying" && !sessionIsExpired) {
      const clarResult = parseClarificationResponse(content, existingSession);
      if (!clarResult.recognized) {
        // Re-ask — don't let the regular agent respond to this message either
        ctx.logger.info(`[telegram-bootstrap] clarification response not recognized, re-asking (conversation: ${conversationId})`);
        await sendTelegramText(ctx, conversationId, buildClarificationMessage(
          { rawIdea: existingSession.rawIdea, stackHint: existingSession.stackHint ?? undefined, projectName: existingSession.projectName ?? undefined },
          existingSession.pendingClarification ?? undefined,
          existingSession.language ?? "pt",
        ));
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
      startFreshBootstrapResume(ctx, workspaceDir, conversationId, () => enterBootstrapping(
        workspaceDir,
        conversationId,
        mergedRequest,
        existingSession.sourceRoute ?? {
          channel: "telegram",
          channelId: conversationId,
        },
        existingSession.language ?? "pt",
        {
          ackSentAt: existingSession.ackSentAt ?? null,
        },
      ));
      return;
    }

    if (!isBootstrapCandidate(content)) {
      // Layer 3: LLM for ambiguous cases (fire-and-forget)
      if (isAmbiguousCandidate(content)) {
        // Create session IMMEDIATELY with pending_classify to suppress agent response for this turn
        await upsertTelegramBootstrapSession(workspaceDir, {
          conversationId,
          rawIdea: content,
          sourceRoute: { channel: "telegram", channelId: conversationId },
          status: "pending_classify",
          ...freshBootstrapResetFields({ rawIdea: content }),
        });

        // Fire-and-forget: LLM classify + bootstrap runs detached from event handler
        classifyAndBootstrap(ctx, workspaceDir, conversationId, content).catch((err) => {
          logBootstrapWarning(ctx, `[telegram-bootstrap] LLM classify error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      return;
    }

    const parsed = parseBootstrapRequest(content);

    // Dedup guard: compute hash from parsed fields (pre-LLM, projectName may be null)
    // and check for existing in-flight sessions before starting classification.
    const preClassifyRequest = {
      rawIdea: parsed.rawIdea,
      projectName: parsed.projectName ?? null,
      stackHint: parsed.stackHint ?? null,
      repoUrl: parsed.repoUrl ?? null,
      repoPath: parsed.repoPath ?? null,
    };
    const preClassifyHash = buildBootstrapRequestHash(preClassifyRequest);
    const sessionForHashPreClassify = await readTelegramBootstrapSession(workspaceDir, conversationId);
    // Hash guard uses pre-LLM state (projectName may be null). For messages without a structured
    // projectName, the hash will NOT match a previously stored post-LLM session (which includes
    // the LLM-derived slug). Dedup in that window is carried by the pending_classify session
    // status check below, not by this hash guard.
    if (sessionForHashPreClassify?.requestHash === preClassifyHash) {
      if (sessionForHashPreClassify.status === "completed") {
        ctx.logger.info(`[telegram-bootstrap] duplicate completed DM ignored for conversation ${conversationId}`);
        return;
      }
      // Allow restart if pipeline is stuck in "received" with an expired suppress window.
      // This happens when the gateway restarts mid-pipeline (session never reached "failed").
      const isExpiredReceived =
        sessionForHashPreClassify.status === "received" &&
        Date.parse(sessionForHashPreClassify.suppressUntil) < Date.now();
      // Note: unlike Layer 3, this guard intentionally does NOT exclude "classifying" status.
      // If a "classifying" session has a matching hash and is still active, Layer 2 is correctly
      // blocked — this avoids double-firing during the LLM classification window.
      if (sessionForHashPreClassify.status !== "failed" && !isExpiredReceived) {
        ctx.logger.info(`[telegram-bootstrap] duplicate in-flight DM ignored for conversation ${conversationId}`);
        return;
      }
      if (isExpiredReceived) {
        ctx.logger.info(`[telegram-bootstrap] stale received session (expired) — restarting pipeline for conversation ${conversationId}`);
      }
    }

    // If no projectName from structured fields, try LLM slug derivation
    if (!parsed.projectName && ctx.runtime?.subagent?.run != null) {
      // Bug B fix: create pending_classify session BEFORE await to prevent suppress race
      // (same pattern as Layer 3). The session is overwritten with "received" status after
      // the LLM call completes.
      await upsertTelegramBootstrapSession(workspaceDir, {
        conversationId,
        rawIdea: parsed.rawIdea,
        sourceRoute: { channel: "telegram", channelId: conversationId },
        status: "pending_classify",
        ...freshBootstrapResetFields({ rawIdea: parsed.rawIdea }),
      });
      const classification = await classifyDmIntent(ctx, content, workspaceDir);
      if (classification?.projectSlug) {
        parsed.projectName = classification.projectSlug;
      }
    }

    const incomingRequest = {
      rawIdea: parsed.rawIdea,
      projectName: parsed.projectName ?? null,
      stackHint: parsed.stackHint ?? null,
      repoUrl: parsed.repoUrl ?? null,
      repoPath: parsed.repoPath ?? null,
    };

    // Layer 2 language heuristic: detect from the matched createCue
    const language: BootstrapLanguage = /\b(cria|crie|criar|construa|desenvolva|registre|novo projeto)\b/i.test(content)
      ? "pt" : "en";

    if (!parsed.stackHint) {
      await startFreshBootstrapResume(ctx, workspaceDir, conversationId, () => enterBootstrapping(
        workspaceDir,
        conversationId,
        incomingRequest,
        {
          channel: "telegram",
          channelId: conversationId,
        },
        language,
      ));
      return;
    }

    const handled = await runBootstrapPreflightOrFail(
      ctx,
      conversationId,
      workspaceDir,
      incomingRequest,
      {
        channel: "telegram",
        channelId: conversationId,
      },
      { language },
    );
    if (handled) return;

    startFreshBootstrapResume(ctx, workspaceDir, conversationId, () => enterBootstrapping(
      workspaceDir,
      conversationId,
      incomingRequest,
      {
        channel: "telegram",
        channelId: conversationId,
      },
      language,
    ));
  });
}
