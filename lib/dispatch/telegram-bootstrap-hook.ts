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
import {
  buildBootstrapRequestHash,
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

function isBootstrapCandidate(text: string): boolean {
  const lower = text.toLowerCase();
  if (/^\s*(project name|nome do projeto|repository url|repo url|stack)\s*:/im.test(text)) return true;
  const createCue = /\b(crie|criar|create|register|registre|novo projeto|new project)\b/.test(lower);
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

function buildClarificationMessage(parsed: BootstrapRequest, pendingClarification?: "stack" | "stack_and_name"): string {
  if (pendingClarification === "stack_and_name" || (!parsed.stackHint && !parsed.projectName)) {
    return `Beleza! Só preciso de duas coisas pra criar:\n\n1. Qual stack? (Python, Node.js, Go, Java...)\n2. Quer dar um nome pro projeto? Se não, eu invento um.`;
  }
  return `Qual stack você quer usar? (Python, Node.js, Go, Java...)`;
}

function buildFollowUpClarification(session: TelegramBootstrapSession): string {
  if (!session.stackHint) {
    return `Não consegui identificar a stack. Pode me dizer qual linguagem/framework você quer usar? Ex: Python, Node.js, Go, Java...`;
  }
  return `Pode me dar mais detalhes sobre o que você quer construir?`;
}

function buildDmAck(projectName: string, topicName: string): string {
  return [
    `Projeto "${projectName}" registrado.`,
    `Vou continuar o fluxo no tópico "${topicName}" do grupo de projetos.`,
  ].join("\n");
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

    // Check for existing clarifying session BEFORE isBootstrapCandidate()
    const existingSession = await readTelegramBootstrapSession(workspaceDir, conversationId);
    // If the clarifying session has expired, treat any new bootstrap candidate as a fresh request
    const sessionIsExpired = existingSession != null && Date.parse(existingSession.suppressUntil) < Date.now();
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

    if (!isBootstrapCandidate(content)) return;

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
      if (sessionForHash.status !== "failed" && !isExpiredReceived) {
        ctx.logger.info(`[telegram-bootstrap] duplicate in-flight DM ignored for conversation ${conversationId}`);
        return;
      }
      if (isExpiredReceived) {
        ctx.logger.info(`[telegram-bootstrap] stale received session (expired) — restarting pipeline for conversation ${conversationId}`);
      }
    }

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
