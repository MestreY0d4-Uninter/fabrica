#!/usr/bin/env tsx
/**
 * genesis-trigger.ts — Standalone script to trigger the genesis pipeline
 * without requiring Telegram or a running agent session.
 *
 * Usage:
 *   tsx scripts/genesis-trigger.ts "Ideia do projeto" [--stack python-cli] [--dry-run]
 *
 * This is the programmatic gap that allows triggering genesis from CLI.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseGenesisArgs, loadAnswersFromFile } from "./genesis-trigger-args.js";

const execFileAsync = promisify(execFile);

const WORKSPACE_DIR = join(homedir(), ".openclaw", "workspace");

// --- Parse CLI args ---
const parsed = parseGenesisArgs(process.argv.slice(2));
if (parsed.error) {
  console.error(`Error: ${parsed.error}`);
  console.error('Usage: tsx scripts/genesis-trigger.ts "idea text" [--stack python-cli] [--name slug] [--channel-id -100xxx] [--dry-run]');
  process.exit(1);
}
const { rawIdea, stackHint, projectName, channelId, dryRun: dryRunFlag } = parsed;

// --- Build StepContext ---
type RunCommandFn = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number; cwd?: string; env?: Record<string, string | undefined> },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const runCommand: RunCommandFn = async (cmd, cmdArgs, opts) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
      timeout: opts?.timeout ?? 120_000,
      cwd: opts?.cwd,
      env: { ...process.env, ...(opts?.env ?? {}) } as NodeJS.ProcessEnv,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
};

// --- Import pipeline steps ---
const { receiveStep } = await import("../lib/intake/steps/receive.js");
const { classifyStep } = await import("../lib/intake/steps/classify.js");
const { interviewStep } = await import("../lib/intake/steps/interview.js");
const { conductInterviewStep } = await import("../lib/intake/steps/conduct-interview.js");
const { generateSpecStep } = await import("../lib/intake/steps/generate-spec.js");
const { runPipeline } = await import("../lib/intake/pipeline.js");
const { saveGenesisSession, issueCommitToken, loadGenesisSession } = await import(
  "../lib/tools/admin/genesis-session.js"
);
const { createProvider } = await import("../lib/providers/index.js");

const stepCtx = {
  runCommand,
  createIssueProvider: async (opts: {
    repoPath?: string;
    repo?: string;
    projectSlug?: string | null;
    provider?: "github" | "gitlab";
    providerProfile?: string;
  }) => {
    return createProvider({
      repoPath: opts.repoPath,
      repo: opts.repo,
      provider: opts.provider,
      providerProfile: opts.providerProfile,
      pluginConfig: undefined,
      runCommand: (cmdArr: string[], optionsOrTimeout: number | { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv }) => {
        const opts = typeof optionsOrTimeout === "number"
          ? { timeoutMs: optionsOrTimeout }
          : optionsOrTimeout;
        return runCommand(cmdArr[0], cmdArr.slice(1), {
          timeout: opts.timeoutMs,
          cwd: opts.cwd,
          env: opts.env as Record<string, string | undefined> | undefined,
        }).then((r) => ({
          stdout: r.stdout,
          stderr: r.stderr,
          code: r.exitCode,
          signal: null as NodeJS.Signals | null,
          killed: false,
          termination: "exit" as const,
        }));
      },
    });
  },
  log: (msg: string) => console.log(`[genesis] ${msg}`),
  homeDir: homedir(),
  workspaceDir: WORKSPACE_DIR,
};

// --- Interview answers (configurable via --answers JSON file) ---
const answers = loadAnswersFromFile(parsed.answersPath);

const sessionId = randomUUID();

console.log("=== Fabrica Genesis Trigger ===");
console.log(`Session ID: ${sessionId}`);
console.log(`Idea: ${rawIdea}`);
console.log(`Stack: ${stackHint ?? "auto-detect"}`);
console.log(`Project name: ${projectName ?? "auto"}`);
console.log(`Channel ID: ${channelId}`);
console.log(`Dry run: ${dryRunFlag}`);
console.log("");

// --- PHASE 1: DISCOVER ---
console.log("--- Phase: discover ---");

let payload: Record<string, unknown> = {
  session_id: sessionId,
  timestamp: new Date().toISOString(),
  step: "init",
  raw_idea: rawIdea,
  answers: {},
  dry_run: dryRunFlag,
  metadata: {
    source: "genesis-trigger-script",
    stack_hint: stackHint ?? null,
    repo_url: null,
    project_name: projectName ?? null,
    command: null,
    timeout_ms: null,
    answers_json: {},
    factory_change: false,
    channel_id: channelId,
  },
};

// Step by step through discover
let p: unknown = payload;

console.log("[1/5] receive...");
p = await receiveStep.execute(p as never, stepCtx as never);
console.log("[2/5] classify...");
p = await classifyStep.execute(p as never, stepCtx as never);
console.log("[3/5] interview (generate questions)...");
p = await interviewStep.execute(p as never, stepCtx as never);

// Check if there are pending questions
const pPayload = p as Record<string, unknown>;
const interview = pPayload.interview as { questions?: Array<{ id: string; required?: boolean }> } | undefined;
const pendingQs = interview?.questions?.filter((q: { id: string; required?: boolean }) => {
  const ans = (pPayload.answers as Record<string, unknown> | undefined) ?? {};
  return q.required !== false && !ans[q.id];
}) ?? [];

if (pendingQs.length > 0) {
  console.log(`Interview questions require answers (${pendingQs.length} pending). Injecting pre-set answers...`);
  // Inject answers
  p = { ...pPayload, answers: { ...(pPayload.answers as object ?? {}), ...answers } };
}

console.log("[4/5] conduct-interview (LLM spec)...");
p = await conductInterviewStep.execute(p as never, stepCtx as never);
console.log("[5/5] generate-spec (LLM spec doc)...");
p = await generateSpecStep.execute(p as never, stepCtx as never);

const specPayload = p as Record<string, unknown>;
if (!specPayload.spec) {
  console.error("ERROR: spec generation failed. Payload:", JSON.stringify(specPayload, null, 2));
  process.exit(1);
}

console.log("Discover complete! Spec generated.");

// Persist session and get commit token
const persisted = saveGenesisSession(WORKSPACE_DIR, specPayload as never, "discover", true);
const commitToken = issueCommitToken(WORKSPACE_DIR, persisted as never);

console.log(`Commit token: ${commitToken.slice(0, 40)}...`);
console.log("");

if (dryRunFlag) {
  console.log("DRY RUN: skipping commit phase");
  console.log("Spec preview:", String(specPayload.spec ?? "").slice(0, 500));
  process.exit(0);
}

// --- PHASE 2: COMMIT ---
console.log("--- Phase: commit ---");
console.log("Running full pipeline (scaffold, create repo, create issue, register, triage)...");

const commitPayload = {
  ...persisted,
  step: "init",
  dry_run: false,
  timestamp: new Date().toISOString(),
  metadata: {
    ...(persisted as Record<string, unknown> & { metadata?: Record<string, unknown> }).metadata,
    source: "genesis-trigger-script",
  },
};

const result = await runPipeline(commitPayload as never, stepCtx as never);

console.log("");
console.log("=== Pipeline Result ===");
console.log(`Success: ${result.success}`);
console.log(`Duration: ${result.duration_ms}ms`);
console.log(`Steps executed: ${result.steps_executed.join(", ")}`);
console.log(`Steps skipped: ${result.steps_skipped.join(", ")}`);
if (result.error) {
  console.error(`Error: ${result.error}`);
}
const rPayload = result.payload as Record<string, unknown>;
const issues = rPayload.issues as Array<{ html_url?: string; number?: number }> | undefined;
const scaffold = rPayload.scaffold as { repo_url?: string; repo_name?: string } | undefined;
if (scaffold?.repo_url) {
  console.log(`Repo: ${scaffold.repo_url}`);
}
if (issues && issues.length > 0) {
  const issue = issues[0];
  console.log(`Issue: #${issue.number} — ${issue.html_url}`);
}

// --- Create Telegram forum topic (equivalent to Telegram DM bootstrap) ---
if (result.success && !dryRunFlag) {
  const { resolveTopicCreationParams } = await import("./genesis-trigger-telegram.js");
  const envPath = join(homedir(), ".openclaw", ".env");

  let envContent: string | null = null;
  try {
    envContent = readFileSync(envPath, "utf-8");
  } catch {
    // File missing — resolveTopicCreationParams will handle the error
  }

  const slug = projectName ?? (scaffold?.repo_name ?? "");
  const topicParams = resolveTopicCreationParams({ envPath, envContent, slug, channelId });

  if (topicParams.error) {
    console.warn(`Telegram topic creation skipped: ${topicParams.error}`);
  } else {
    console.log("\n--- Creating Telegram forum topic ---");
    try {
      const topicRes = await fetch(
        `https://api.telegram.org/bot${topicParams.botToken}/createForumTopic`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: parseInt(topicParams.channelId, 10),
            name: `📦 ${topicParams.slug}`,
            icon_color: 7322096,
          }),
        },
      );
      const topicData = (await topicRes.json()) as {
        ok: boolean;
        result?: { message_thread_id: number };
        description?: string;
      };

      if (topicData.ok && topicData.result) {
        const messageThreadId = topicData.result.message_thread_id;
        console.log(`Topic created: messageThreadId=${messageThreadId}`);
        const { updateProjectTopic } = await import("./genesis-trigger-projects.js");
        const updateResult = await updateProjectTopic({
          workspaceDir: WORKSPACE_DIR,
          slug: topicParams.slug,
          channelId: topicParams.channelId,
          messageThreadId,
        });

        if (updateResult.success) {
          console.log(`projects.json updated for "${topicParams.slug}"`);
        } else {
          console.warn(`projects.json update failed: ${updateResult.error}`);
        }
      } else {
        console.warn(`Telegram API error: ${topicData.description ?? "unknown"}`);
      }
    } catch (err) {
      console.warn("Telegram topic creation failed (non-fatal):", err);
    }
  }
}
