/**
 * genesis — Intake pipeline tool.
 *
 * Transforms raw ideas into structured specs, scaffolded projects,
 * GitHub issues, and triaged work items.
 *
 * Phases:
 *   discover — Classify, interview, generate spec (returns questions or commit_token)
 *   commit   — Execute full pipeline (scaffold, create task, triage)
 */
import { jsonResult } from "../../runtime/plugin-sdk-compat.js";
import type { PluginContext } from "../../context.js";
import type { ToolContext } from "../../types.js";
import { requireWorkspaceDir } from "../helpers.js";
import { runPipeline, type GenesisPayload, type StepContext } from "../../intake/index.js";
import { homedir } from "node:os";
import { createProvider } from "../../providers/index.js";
import { loadProjectBySlug } from "../../projects/io.js";
import {
  ensureCommitReady,
  issueCommitToken,
  loadGenesisSession,
  normalizeGenesisRequest,
  saveGenesisSession,
} from "./genesis-session.js";

export function createGenesisTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "genesis",
    label: "Genesis",
    description: `Transform raw ideas into structured engineering work.

Phase "discover": Classify the idea, generate interview questions, produce a spec.
  - Returns status="blocked" + questions[] if clarification needed
  - Returns status="ready" + commit_token when spec is complete

Phase "commit": Execute the full pipeline (scaffold, create issue, triage).
  - Requires a valid commit_token from a previous discover phase.

Examples:
- Discover: { phase: "discover", idea: "Create a CLI to count words" }
- With answers: { phase: "discover", session_id: "...", idea: "...", answers: {...} }
- Commit: { phase: "commit", commit_token: "..." }`,
    parameters: {
      type: "object",
      properties: {
        phase: {
          type: "string",
          enum: ["discover", "commit"],
          description: 'Pipeline phase: "discover" or "commit".',
        },
        idea: {
          type: "string",
          description: "The raw idea text (required for discover phase).",
        },
        session_id: {
          type: "string",
          description: "Session ID from a previous discover call (for follow-up).",
        },
        answers: {
          type: "object",
          description: "Answers to interview questions from a previous discover call.",
        },
        answers_json: {
          oneOf: [{ type: "object" }, { type: "string" }],
          description: "Legacy-compatible JSON answers payload. Accepts an object or a JSON object string.",
        },
        commit_token: {
          type: "string",
          description: "Token from a completed discover phase (required for commit).",
        },
        repo_url: {
          type: "string",
          description: "Optional repository URL for existing-project intake.",
        },
        project_name: {
          type: "string",
          description: "Optional project/repository display name.",
        },
        repo_name: {
          type: "string",
          description: "Alias for project_name.",
        },
        factory_change: {
          type: "boolean",
          description: "Allow Fabrica/internal repository targeting when true.",
        },
        stack: {
          type: "string",
          description: "Optional stack hint supplied by the caller.",
        },
        command: {
          type: "string",
          description: "Original raw command text, used as fallback idea/context.",
        },
        timeout_ms: {
          type: "number",
          description: "Optional default timeout hint for OpenClaw CLI calls triggered by this tool.",
        },
        dry_run: {
          type: "boolean",
          description: "If true, skip repo creation and issue creation.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = requireWorkspaceDir(toolCtx);
      const existingPayload =
        typeof params.session_id === "string" && params.session_id.trim()
          ? loadGenesisSession(workspaceDir, params.session_id.trim())
          : null;
      let normalized: ReturnType<typeof normalizeGenesisRequest>;
      try {
        normalized = normalizeGenesisRequest(
          {
            ...params,
            project_name: params.project_name ?? params.repo_name,
          },
          existingPayload ?? undefined,
        );
      } catch (error) {
        return jsonResult({
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const defaultTimeoutMs = normalized.metadata.timeout_ms ?? 60000;

      const stepCtx: StepContext = {
        runCommand: async (cmd, args, opts) => {
          const result = await ctx.runCommand([cmd, ...args], {
            timeoutMs: opts?.timeout ?? defaultTimeoutMs,
            cwd: opts?.cwd,
            env: opts?.env,
          });
          return {
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            exitCode: (result as any).code ?? 0,
          };
        },
        createIssueProvider: async (opts) => {
          let providerProfile = opts.providerProfile;
          if (!providerProfile && opts.projectSlug) {
            const project = await loadProjectBySlug(workspaceDir, opts.projectSlug);
            providerProfile = project?.providerProfile;
          }
          return createProvider({
            repoPath: opts.repoPath,
            repo: opts.repo,
            provider: opts.provider,
            providerProfile,
            pluginConfig: ctx.pluginConfig,
            runCommand: ctx.runCommand,
          });
        },
        log: (msg) => ctx.logger.info(`[genesis] ${msg}`),
        homeDir: homedir(),
        workspaceDir,
        runtime: ctx.runtime,
        config: ctx.config as Record<string, unknown>,
        pluginConfig: ctx.pluginConfig,
      };

      if (normalized.phase === "discover") {
        return handleDiscover(normalized, existingPayload ?? undefined, stepCtx);
      }

      if (normalized.phase === "commit") {
        return handleCommit(params, normalized, stepCtx);
      }

      return jsonResult({ error: `Unknown phase: ${normalized.phase}` });
    },
  });
}

async function handleDiscover(
  normalized: ReturnType<typeof normalizeGenesisRequest>,
  existingPayload: GenesisPayload | undefined,
  ctx: StepContext,
): Promise<any> {
  if (!normalized.rawIdea) {
    return jsonResult({ error: "idea is required for discover phase unless resuming a stored session" });
  }

  const payload: GenesisPayload = {
    ...(existingPayload ?? {}),
    session_id: normalized.sessionId,
    timestamp: new Date().toISOString(),
    step: "init",
    raw_idea: normalized.rawIdea,
    answers: normalized.answers,
    dry_run: normalized.dryRun,
    metadata: {
      ...(existingPayload?.metadata ?? {}),
      source: "genesis-tool",
      ...normalized.metadata,
      factory_change:
        normalized.metadata.factory_change ??
        existingPayload?.metadata.factory_change ??
        false,
    },
  };

  // Run step-by-step up to spec generation
  const { receiveStep } = await import("../../intake/steps/receive.js");
  const { classifyStep } = await import("../../intake/steps/classify.js");
  const { interviewStep } = await import("../../intake/steps/interview.js");
  const { conductInterviewStep } = await import("../../intake/steps/conduct-interview.js");
  const { generateSpecStep } = await import("../../intake/steps/generate-spec.js");

  let p = payload;
  p = await receiveStep.execute(p, ctx);
  p = await classifyStep.execute(p, ctx);
  p = await interviewStep.execute(p, ctx);
  const pendingQuestions = getPendingQuestions(p, normalized.answers);

  if (pendingQuestions.length > 0) {
    const persisted = saveGenesisSession(ctx.workspaceDir, p, "discover", false);
    return jsonResult({
      status: "blocked",
      session_id: persisted.session_id,
      questions: pendingQuestions,
      normalized_inputs: persisted.metadata,
    });
  }

  p = await conductInterviewStep.execute(p, ctx);
  p = await generateSpecStep.execute(p, ctx);

  // If spec is complete, persist session and return commit_token
  if (p.spec) {
    const persisted = saveGenesisSession(ctx.workspaceDir, p, "discover", true);

    return jsonResult({
      status: "ready",
      session_id: persisted.session_id,
      commit_token: issueCommitToken(ctx.workspaceDir, persisted),
      spec: persisted.spec,
      classification: persisted.classification,
      normalized_inputs: persisted.metadata,
    });
  }

  const persisted = saveGenesisSession(ctx.workspaceDir, p, "discover", false);
  return jsonResult({
    status: "blocked",
    session_id: persisted.session_id,
    questions: persisted.interview?.questions ?? [],
    normalized_inputs: persisted.metadata,
  });
}

async function handleCommit(
  params: Record<string, unknown>,
  normalized: ReturnType<typeof normalizeGenesisRequest>,
  ctx: StepContext,
): Promise<any> {
  const commitToken = params.commit_token as string;
  const dryRun = normalized.dryRun;
  const explicitSessionId =
    typeof params.session_id === "string" && params.session_id.trim()
      ? params.session_id.trim()
      : null;

  if (!commitToken && !normalized.rawIdea) {
    return jsonResult({ error: "commit_token or idea is required for commit phase" });
  }

  try {
    const storedPayload = commitToken
      ? ensureCommitReady(ctx.workspaceDir, commitToken, explicitSessionId)
      : null;
    const payload: GenesisPayload = storedPayload
      ? {
          ...storedPayload,
          step: "init",
          dry_run: dryRun,
          timestamp: new Date().toISOString(),
          metadata: {
            ...storedPayload.metadata,
            source: "genesis-tool",
            ...normalized.metadata,
            factory_change:
              normalized.metadata.factory_change ??
              storedPayload.metadata.factory_change ??
              false,
          },
        }
      : {
          session_id: normalized.sessionId,
          timestamp: new Date().toISOString(),
          step: "init",
          raw_idea: normalized.rawIdea ?? "",
          answers: normalized.answers,
          dry_run: dryRun,
          metadata: {
            source: "genesis-tool",
            ...normalized.metadata,
            factory_change: normalized.metadata.factory_change ?? false,
          },
        };

    const result = await runPipeline(payload, ctx);
    const projectRegistered = result.payload.metadata.project_registered === true;
    const hasRunnableWork =
      (result.payload.issues?.length ?? 0) > 0 ||
      result.payload.triage?.ready_for_dispatch === true;
    const programmaticCommitFailedClosed =
      !dryRun &&
      result.success &&
      !projectRegistered &&
      !hasRunnableWork;
    const success = programmaticCommitFailedClosed ? false : result.success;
    const error = programmaticCommitFailedClosed
      ? "Programmatic commit produced no registered project and no runnable work"
      : result.error;

    return jsonResult({
      success,
      session_id: result.payload.session_id,
      steps_executed: result.steps_executed,
      steps_skipped: result.steps_skipped,
      duration_ms: result.duration_ms,
      error,
      spec: result.payload.spec,
      scaffold: result.payload.scaffold,
      qa_contract: result.payload.qa_contract,
      security: result.payload.security,
      issues: result.payload.issues,
      triage: result.payload.triage,
    });
  } catch (error) {
    return jsonResult({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function getPendingQuestions(payload: GenesisPayload, answers = payload.answers ?? {}) {
  return (payload.interview?.questions ?? []).filter((question) => {
    if (!question.required) return false;
    return !String(answers[question.id] ?? "").trim();
  });
}
