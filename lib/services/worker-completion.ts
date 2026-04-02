import type { IssueProvider, PrStatus } from "../providers/provider.js";
import type { RunCommand } from "../context.js";
import { log as auditLog } from "../audit.js";
import type { FabricaPluginConfig } from "../config/types.js";
import { loadConfig } from "../config/index.js";
import { createProvider } from "../providers/index.js";
import {
  getIssueRuntime,
  getRoleWorker,
  readProjects,
  recordIssueLifecycle,
  resolveRepoPath,
  updateIssueRuntime,
} from "../projects/index.js";
import { parseFabricaSessionKey } from "../dispatch/bootstrap-hook.js";
import { executeCompletion } from "./pipeline.js";
import { extractWorkerResultFromMessages, type WorkerResult, type WorkerRole } from "./worker-result.js";
import { validatePrExistsForDeveloper } from "../tools/worker/work-finish.js";
import { applyTesterInfraFailureCompletion, hasCurrentDispatchAlreadyCompleted, resolveWorkerSlot } from "./worker-completion-shared.js";

type WorkerCompletionOutcome = { applied: boolean; reason?: string };

type RuntimeLike = {
  system?: { requestHeartbeatNow?: (opts: { reason: string; coalesceMs?: number }) => void };
  subagent?: { getSessionMessages?: (opts: { sessionKey: string }) => Promise<unknown> };
};

type DeveloperDoneValidationResult = {
  ok: boolean;
  reason?: string;
  prStatus?: PrStatus;
};

type WorkerObservation = {
  result: WorkerResult | null;
  activityObserved: boolean;
  executionContractViolation?: {
    reason: "meta_skill" | "nested_coding_agent";
    evidence: string;
  };
};

type WorkerSessionContext = {
  sessionKey: string;
  parsed: { projectName: string; role: WorkerRole };
  projectSlug: string;
  project: Awaited<ReturnType<typeof readProjects>>["projects"][string];
  issueId: number;
  slotLevel: string;
  slotIndex: number;
  recovered: boolean;
  dispatchCycleId?: string | null;
  dispatchRunId?: string | null;
  issueRuntime: ReturnType<typeof getIssueRuntime>;
};

const RESULT_MAP: Record<Exclude<WorkerRole, "reviewer">, Record<string, string>> = {
  developer: {
    DONE: "done",
    BLOCKED: "blocked",
  },
  tester: {
    PASS: "pass",
    FAIL: "fail",
    FAIL_INFRA: "fail_infra",
    REFINE: "refine",
    BLOCKED: "blocked",
  },
  architect: {
    DONE: "done",
    BLOCKED: "blocked",
  },
};

async function resolveWorkerResultFromRuntime(
  role: Exclude<WorkerRole, "reviewer">,
  sessionKey: string,
  messages: unknown[] | undefined,
  runtime?: RuntimeLike,
): Promise<WorkerObservation> {
  const eventMessages = Array.isArray(messages) ? messages : [];
  const eventActivityObserved = hasObservableWorkerActivity(eventMessages);
  const eventResult = extractWorkerResultFromMessages(role, eventMessages);
  const eventViolation = detectExecutionContractViolation(eventMessages);
  if (eventResult) {
    return { result: eventResult, activityObserved: eventActivityObserved };
  }

  try {
    const messagesResult = await runtime?.subagent?.getSessionMessages?.({ sessionKey });
    if (!messagesResult) {
      return {
        result: null,
        activityObserved: eventActivityObserved,
        executionContractViolation: eventViolation ?? undefined,
      };
    }

    const sessionMessages: unknown[] = Array.isArray(messagesResult)
      ? messagesResult
      : (Array.isArray((messagesResult as { messages?: unknown[] }).messages)
        ? (messagesResult as { messages: unknown[] }).messages
        : []);
    const sessionActivityObserved = hasObservableWorkerActivity(sessionMessages);
    const historyResult = extractWorkerResultFromMessages(role, sessionMessages);
    if (!historyResult) {
      const sessionViolation = detectExecutionContractViolation(sessionMessages);
      return {
        result: null,
        activityObserved: eventActivityObserved || sessionActivityObserved,
        executionContractViolation: sessionViolation ?? eventViolation ?? undefined,
      };
    }

    return {
      result: {
        ...historyResult,
        source: "session_history",
      },
      activityObserved: eventActivityObserved || sessionActivityObserved,
    };
  } catch {
    return {
      result: null,
      activityObserved: eventActivityObserved,
      executionContractViolation: eventViolation ?? undefined,
    };
  }
}

function asWorkerRole(role: string): WorkerRole | null {
  return role === "developer" || role === "tester" || role === "architect" || role === "reviewer"
    ? role
    : null;
}

function hasObservableWorkerActivity(messages: unknown[]): boolean {
  return messages.some((message) => {
    if (typeof message !== "object" || message == null) return false;
    const role = (message as { role?: unknown }).role;
    if (role !== "assistant" && role !== "toolResult") return false;
    return hasObservableContent((message as { content?: unknown }).content);
  });
}

async function ensureCurrentWorkerDispatch(opts: {
  context: WorkerSessionContext | null;
  workspaceDir: string;
  sessionKey: string;
  role: Exclude<WorkerRole, "reviewer">;
  runId?: string;
}): Promise<WorkerCompletionOutcome | null> {
  const context = opts.context;
  if (!context) return null;

  const currentDispatchRunId = context.dispatchRunId ?? context.issueRuntime?.dispatchRunId ?? null;
  if (opts.runId && currentDispatchRunId && opts.runId !== currentDispatchRunId) {
    await auditLog(opts.workspaceDir, "worker_completion_skipped", {
      sessionKey: opts.sessionKey,
      projectSlug: context.projectSlug,
      issueId: context.issueId,
      role: opts.role,
      reason: "stale_dispatch_cycle",
      eventRunId: opts.runId,
      currentDispatchRunId,
    }).catch(() => {});
    return { applied: false, reason: "stale_dispatch_cycle" };
  }

  if (
    context.dispatchCycleId &&
    context.issueRuntime?.lastDispatchCycleId &&
    context.dispatchCycleId !== context.issueRuntime.lastDispatchCycleId
  ) {
    await auditLog(opts.workspaceDir, "worker_completion_skipped", {
      sessionKey: opts.sessionKey,
      projectSlug: context.projectSlug,
      issueId: context.issueId,
      role: opts.role,
      reason: "stale_dispatch_cycle",
    }).catch(() => {});
    return { applied: false, reason: "stale_dispatch_cycle" };
  }

  if (hasCurrentDispatchAlreadyCompleted(context.issueRuntime)) {
    await auditLog(opts.workspaceDir, "worker_completion_skipped", {
      sessionKey: opts.sessionKey,
      projectSlug: context.projectSlug,
      issueId: context.issueId,
      role: opts.role,
      reason: "already_completed",
    }).catch(() => {});
    return { applied: false, reason: "already_completed" };
  }

  return null;
}

function hasObservableContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;

  return content.some((block) => {
    if (typeof block === "string") return block.trim().length > 0;
    if (typeof block !== "object" || block == null) return false;

    const typedBlock = block as { type?: unknown; text?: unknown; thinking?: unknown };
    if (typedBlock.type === "toolCall" || typedBlock.type === "toolResult") return true;
    if (typedBlock.type === "text" && typeof typedBlock.text === "string") {
      return typedBlock.text.trim().length > 0;
    }
    if (typedBlock.type === "thinking" && typeof typedBlock.thinking === "string") {
      return typedBlock.thinking.trim().length > 0;
    }
    return false;
  });
}

function detectExecutionContractViolation(messages: unknown[]): {
  reason: "meta_skill" | "nested_coding_agent";
  evidence: string;
} | null {
  const evidenceEntries = collectWorkerTranscriptEvidence(messages);
  const assistantEntries = evidenceEntries.filter((entry) => entry.role === "assistant");
  const commandEntries = evidenceEntries.filter((entry) => entry.kind === "command");

  for (const entry of assistantEntries) {
    const explicitDelegation = matchPositiveExplicitDelegation(entry.text);
    if (explicitDelegation) {
      return {
        reason: "nested_coding_agent",
        evidence: explicitDelegation,
      };
    }

    const metaSkillUsage = matchPositiveMetaSkillUsage(entry.text);
    if (metaSkillUsage) {
      return {
        reason: "meta_skill",
        evidence: metaSkillUsage,
      };
    }
  }

  const codingAgentIntent = assistantEntries
    .map((entry) => matchCodingAgentIntent(entry.text))
    .find((match): match is string => Boolean(match));
  const nestedCommand = commandEntries
    .map((entry) => matchNestedCommand(entry.text))
    .find((match): match is string => Boolean(match));

  if (codingAgentIntent && nestedCommand) {
    return {
      reason: "nested_coding_agent",
      evidence: `${codingAgentIntent} | ${nestedCommand}`.slice(0, 160),
    };
  }

  return null;
}

function collectWorkerTranscriptEvidence(messages: unknown[]): Array<{
  role: "assistant" | "toolCall" | "toolResult";
  kind: "text" | "thinking" | "command";
  text: string;
}> {
  const evidence: Array<{
    role: "assistant" | "toolCall" | "toolResult";
    kind: "text" | "thinking" | "command";
    text: string;
  }> = [];

  for (const message of messages) {
    if (typeof message !== "object" || message == null) continue;

    const role = (message as { role?: unknown }).role;
    if (role !== "assistant" && role !== "toolResult" && role !== "toolCall") continue;

    collectContentEvidence(role, (message as { content?: unknown }).content, evidence);
  }

  return evidence;
}

function collectContentEvidence(
  role: "assistant" | "toolCall" | "toolResult",
  content: unknown,
  evidence: Array<{
    role: "assistant" | "toolCall" | "toolResult";
    kind: "text" | "thinking" | "command";
    text: string;
  }>,
): void {
  if (typeof content === "string") {
    evidence.push({
      role,
      kind: role === "assistant" ? "text" : "command",
      text: content,
    });
    return;
  }

  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (typeof block === "string") {
      evidence.push({
        role,
        kind: role === "assistant" ? "text" : "command",
        text: block,
      });
      continue;
    }

    if (typeof block !== "object" || block == null) continue;

    const typedBlock = block as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      name?: unknown;
      arguments?: unknown;
      partialJson?: unknown;
    };

    if (typeof typedBlock.text === "string") {
      evidence.push({
        role,
        kind: role === "assistant" ? "text" : "command",
        text: typedBlock.text,
      });
    }

    if (typeof typedBlock.thinking === "string") {
      evidence.push({
        role,
        kind: "thinking",
        text: typedBlock.thinking,
      });
    }

    if (typedBlock.type === "toolCall") {
      if (typeof typedBlock.name === "string") {
        evidence.push({
          role,
          kind: "command",
          text: typedBlock.name,
        });
      }
      if (typeof typedBlock.arguments === "string") {
        evidence.push({
          role,
          kind: "command",
          text: typedBlock.arguments,
        });
      } else if (typedBlock.arguments != null) {
        evidence.push({
          role,
          kind: "command",
          text: JSON.stringify(typedBlock.arguments),
        });
      }
      if (typeof typedBlock.partialJson === "string") {
        evidence.push({
          role,
          kind: "command",
          text: typedBlock.partialJson,
        });
      }
    }
  }
}

function matchPositiveExplicitDelegation(text: string): string | null {
  const normalized = text.toLowerCase();
  return findAcceptedMatch(normalized, [
    {
      pattern: /\b(?:i(?:'ll| will)?|let me|going to|should|need to)\s+(?:spawn|delegate|delegating|launch|launching|hand off|handoff)\b[\s\S]{0,80}\b(?:coding agent|coding-agent|codex|subagent|another agent|child agent)\b[\s\S]{0,80}\b(?:task|work|issue|implement|handle|complete|finish)\b/g,
      rejectOnConcession: true,
    },
    {
      pattern: /\b(?:i(?:'ve| have)|i(?:'m| am)|i)\s+(?:spawned|delegated|launched|handed off)\b[\s\S]{0,80}\b(?:coding agent|coding-agent|codex|subagent|another agent|child agent)\b[\s\S]{0,80}\b(?:task|work|issue|implement|handle|complete|finish)\b/g,
      rejectOnConcession: false,
    },
    {
      pattern: /\b(?:i(?:'ll| will)?|let me|going to|should|need to)\s+(?:delegate|hand off|handoff)\b[\s\S]{0,40}\b(?:task|work|issue)\b[\s\S]{0,40}\bto\b[\s\S]{0,20}\b(?:coding agent|coding-agent|codex|subagent|another agent|child agent)\b/g,
      rejectOnConcession: true,
    },
    {
      pattern: /\b(?:i(?:'ve| have)|i(?:'m| am)|i)\s+(?:delegated|handed off)\b[\s\S]{0,40}\b(?:task|work|issue)\b[\s\S]{0,40}\bto\b[\s\S]{0,20}\b(?:coding agent|coding-agent|codex|subagent|another agent|child agent)\b/g,
      rejectOnConcession: false,
    },
    {
      pattern: /\b(?:i(?:'ve| have)|i(?:'m| am)|i)\s+(?:use|used|using)\b[\s\S]{0,20}\b(?:coding agent|coding-agent|subagent)\b[\s\S]{0,80}\b(?:task|work|issue|implement|handle|complete|finish)\b/g,
      rejectOnConcession: false,
    },
  ]);
}

function matchPositiveMetaSkillUsage(text: string): string | null {
  const normalized = text.toLowerCase();
  return findAcceptedMatch(normalized, [
    {
      pattern: /\b(?:i(?:'ll| will)?|let me|going to|should|need to|can)\s+(?:use|load|invoke|follow|read)\s+brainstorming\b/g,
      rejectOnConcession: true,
    },
    {
      pattern: /\b(?:i(?:'ll| will)?|let me|going to|should|need to|can)\s+(?:use|load|invoke|follow|read)\s+writing-plans\b/g,
      rejectOnConcession: true,
    },
    {
      pattern: /\b(?:i(?:'ve| have)|i(?:'m| am)|i)\s+(?:use|used|using|load|loaded|loading|invoke|invoked|invoking|follow|followed|following|read|reading)\s+brainstorming\b/g,
      rejectOnConcession: false,
    },
    {
      pattern: /\b(?:i(?:'ve| have)|i(?:'m| am)|i)\s+(?:use|used|using|load|loaded|loading|invoke|invoked|invoking|follow|followed|following|read|reading)\s+writing-plans\b/g,
      rejectOnConcession: false,
    },
  ]);
}

function matchCodingAgentIntent(text: string): string | null {
  const normalized = text.toLowerCase();
  return findAcceptedMatch(normalized, [
    {
      pattern: /\b(?:i(?:'ll| will)?|let me|going to|should|need to)\s+(?:use|load|invoke|follow|read)\b[\s\S]{0,80}\bcoding-agent\b/g,
      rejectOnConcession: true,
    },
    {
      pattern: /\b(?:i(?:'ve| have)|i(?:'m| am)|i)\s+(?:use|used|using|load|loaded|loading|invoke|invoked|invoking|follow|followed|following|read|reading)\b[\s\S]{0,80}\bcoding-agent\b/g,
      rejectOnConcession: false,
    },
  ]);
}

function matchNestedCommand(text: string): string | null {
  const normalized = text.toLowerCase();
  const match = normalized.match(/\bcodex exec --full-auto\b/);
  return match ? match[0] : null;
}

function findAcceptedMatch(
  normalized: string,
  patterns: Array<{ pattern: RegExp; rejectOnConcession: boolean }>,
): string | null {
  for (const { pattern, rejectOnConcession } of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const matchedText = match[0];
      if (!matchedText) continue;
      const end = (match.index ?? 0) + matchedText.length;
      if (rejectOnConcession && hasImmediateRejection(normalized, end)) continue;
      return matchedText;
    }
  }

  return null;
}

function hasImmediateRejection(normalized: string, matchEnd: number): boolean {
  const trailingClause = normalized.slice(matchEnd, matchEnd + 120);
  return /\b(?:but|however|though|except)\b[\s\S]{0,80}\b(?:forbid|forbids|forbidden|can't|cannot|can not|won't|will not|must not|should not|do not|don't|did not|didn't|never|stay|stayed)\b/.test(trailingClause);
}

export async function resolveWorkerSessionContext(
  sessionKey: string,
  workspaceDir: string,
): Promise<WorkerSessionContext | null> {
  const parsed = parseFabricaSessionKey(sessionKey);
  const role = parsed ? asWorkerRole(parsed.role) : null;
  if (!parsed || !role) return null;

  const projects = await readProjects(workspaceDir);
  const projectEntry = Object.entries(projects.projects).find(([, project]) => project.name === parsed.projectName);
  if (!projectEntry) return null;

  const [projectSlug, project] = projectEntry;
  const roleWorker = getRoleWorker(project, role);
  const slot = resolveWorkerSlot(roleWorker, sessionKey);
  if (!slot) return null;

  return {
    sessionKey,
    parsed: {
      projectName: parsed.projectName,
      role,
    },
    projectSlug,
    project,
    issueId: slot.issueId,
    slotLevel: slot.slotLevel,
    slotIndex: slot.slotIndex,
    recovered: slot.recovered,
    dispatchCycleId: slot.dispatchCycleId ?? null,
    dispatchRunId: slot.dispatchRunId ?? null,
    issueRuntime: getIssueRuntime(project, slot.issueId),
  };
}

async function defaultValidateDeveloperDone(opts: {
  issueId: number;
  repoPath: string;
  provider: IssueProvider;
  runCommand: RunCommand;
  workspaceDir: string;
  projectSlug: string;
  issueRuntime?: ReturnType<typeof getIssueRuntime>;
}): Promise<DeveloperDoneValidationResult> {
  try {
    const prStatus = await validatePrExistsForDeveloper(
      opts.issueId,
      opts.repoPath,
      opts.provider,
      opts.runCommand,
      opts.workspaceDir,
      opts.projectSlug,
      opts.issueRuntime,
    );
    return { ok: true, prStatus };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "developer_validation_failed",
    };
  }
}

async function persistDeveloperPrBinding(opts: {
  workspaceDir: string;
  projectSlug: string;
  issueId: number;
  prStatus?: PrStatus;
}): Promise<void> {
  const prStatus = opts.prStatus;
  if (!prStatus) return;

  await updateIssueRuntime(opts.workspaceDir, opts.projectSlug, opts.issueId, {
    currentPrNodeId: prStatus.nodeId ?? null,
    currentPrNumber: prStatus.number ?? null,
    currentPrUrl: prStatus.url ?? null,
    currentPrState: prStatus.state,
    currentPrSourceBranch: prStatus.sourceBranch ?? null,
    currentPrIssueTarget: prStatus.linkedIssueIds?.includes(opts.issueId) ? opts.issueId : null,
    bindingSource: prStatus.bindingSource === "selector"
      ? "explicit"
      : (prStatus.bindingSource ?? "explicit"),
    bindingConfidence: prStatus.bindingConfidence ?? "high",
    lastResolvedIssueTarget: opts.issueId,
    followUpPrRequired: false,
    boundAt: new Date().toISOString(),
  });
}

export async function applyWorkerResult(opts: {
  context: WorkerSessionContext;
  result: WorkerResult;
  workspaceDir: string;
  runCommand: RunCommand;
  runId?: string;
  runtime?: RuntimeLike;
  pluginConfig?: FabricaPluginConfig;
  providerOverride?: IssueProvider;
  validateDeveloperDone?: (opts: {
    issueId: number;
    repoPath: string;
    provider: IssueProvider;
    runCommand: RunCommand;
    workspaceDir: string;
    projectSlug: string;
    issueRuntime?: ReturnType<typeof getIssueRuntime>;
  }) => Promise<DeveloperDoneValidationResult>;
}): Promise<WorkerCompletionOutcome> {
  const { context } = opts;
  if (context.parsed.role === "reviewer") {
    return { applied: false, reason: "reviewer_result_handled_elsewhere" };
  }

  const provider = opts.providerOverride ?? (
    await createProvider({
      repo: context.project.repo,
      provider: context.project.provider,
      runCommand: opts.runCommand,
    })
  ).provider;
  const { workflow } = await loadConfig(opts.workspaceDir, context.projectSlug);
  const repoPath = resolveRepoPath(context.project.repo);
  const completionResult = RESULT_MAP[context.parsed.role][opts.result.value];

  if (!completionResult) {
    return { applied: false, reason: "unsupported_result" };
  }

  const currentDispatchRunId = context.dispatchRunId ?? context.issueRuntime?.dispatchRunId ?? null;
  if (opts.runId && currentDispatchRunId && opts.runId !== currentDispatchRunId) {
    await auditLog(opts.workspaceDir, "worker_completion_skipped", {
      sessionKey: context.sessionKey,
      projectSlug: context.projectSlug,
      issueId: context.issueId,
      role: context.parsed.role,
      result: opts.result.value,
      reason: "stale_dispatch_cycle",
      eventRunId: opts.runId,
      currentDispatchRunId,
    }).catch(() => {});
    return { applied: false, reason: "stale_dispatch_cycle" };
  }

  if (
    context.dispatchCycleId &&
    context.issueRuntime?.lastDispatchCycleId &&
    context.dispatchCycleId !== context.issueRuntime.lastDispatchCycleId
  ) {
    await auditLog(opts.workspaceDir, "worker_completion_skipped", {
      sessionKey: context.sessionKey,
      projectSlug: context.projectSlug,
      issueId: context.issueId,
      role: context.parsed.role,
      result: opts.result.value,
      reason: "stale_dispatch_cycle",
    }).catch(() => {});
    return { applied: false, reason: "stale_dispatch_cycle" };
  }

  if (hasCurrentDispatchAlreadyCompleted(context.issueRuntime)) {
    await auditLog(opts.workspaceDir, "worker_completion_skipped", {
      sessionKey: context.sessionKey,
      projectSlug: context.projectSlug,
      issueId: context.issueId,
      role: context.parsed.role,
      result: opts.result.value,
      reason: "already_completed",
    }).catch(() => {});
    return { applied: false, reason: "already_completed" };
  }

  let validatedPrStatus: PrStatus | undefined;
  if (context.parsed.role === "developer" && opts.result.value === "DONE") {
    const validateDeveloperDone = opts.validateDeveloperDone ?? defaultValidateDeveloperDone;
    const validation = await validateDeveloperDone({
      issueId: context.issueId,
      repoPath,
      provider,
      runCommand: opts.runCommand,
      workspaceDir: opts.workspaceDir,
      projectSlug: context.projectSlug,
      issueRuntime: context.issueRuntime,
    });
    if (!validation.ok) {
      await auditLog(opts.workspaceDir, "worker_completion_skipped", {
        sessionKey: context.project.workers[context.parsed.role]?.levels?.[context.slotLevel]?.[context.slotIndex]?.sessionKey ?? null,
        projectSlug: context.projectSlug,
        issueId: context.issueId,
        role: context.parsed.role,
        result: opts.result.value,
        reason: validation.reason ?? "developer_validation_failed",
      }).catch(() => {});
      return { applied: false, reason: validation.reason ?? "developer_validation_failed" };
    }
    validatedPrStatus = validation.prStatus;
    await persistDeveloperPrBinding({
      workspaceDir: opts.workspaceDir,
      projectSlug: context.projectSlug,
      issueId: context.issueId,
      prStatus: validatedPrStatus,
    }).catch(() => {});
  }

  if (context.parsed.role === "tester" && opts.result.value === "FAIL_INFRA") {
    await applyTesterInfraFailureCompletion({
      workspaceDir: opts.workspaceDir,
      projectSlug: context.projectSlug,
      projectName: context.project.name,
      repo: context.project.repo,
      channels: context.project.channels,
      issueId: context.issueId,
      slotLevel: context.slotLevel,
      slotIndex: context.slotIndex,
      provider,
      runtime: opts.runtime as never,
      pluginConfig: opts.pluginConfig,
      runCommand: opts.runCommand,
      source: "agent_end",
      sessionKey: context.sessionKey,
      currentInfraFails: (context.issueRuntime?.infraFailCount ?? 0) + 1,
    });
    await auditLog(opts.workspaceDir, "worker_completion_applied", {
      sessionKey: context.sessionKey,
      projectSlug: context.projectSlug,
      issueId: context.issueId,
      role: context.parsed.role,
      result: opts.result.value,
      source: opts.result.source,
    }).catch(() => {});
    return { applied: true };
  }

  await executeCompletion({
    workspaceDir: opts.workspaceDir,
    projectSlug: context.projectSlug,
    role: context.parsed.role,
    result: completionResult,
    issueId: context.issueId,
    prUrl: validatedPrStatus?.url ?? undefined,
    provider,
    repoPath,
    projectName: context.project.name,
    channels: context.project.channels,
    runtime: opts.runtime as never,
    workflow,
    level: context.slotLevel,
    slotIndex: context.slotIndex,
    runCommand: opts.runCommand,
  });

  await recordIssueLifecycle({
    workspaceDir: opts.workspaceDir,
    slug: context.projectSlug,
    issueId: context.issueId,
    stage: "session_completed",
    sessionKey: context.sessionKey,
    details: { role: context.parsed.role, result: completionResult, source: "agent_end" },
  }).catch(() => {});

  await auditLog(opts.workspaceDir, "worker_completion_applied", {
    sessionKey: context.sessionKey,
    projectSlug: context.projectSlug,
    issueId: context.issueId,
    role: context.parsed.role,
    result: opts.result.value,
    source: opts.result.source,
  }).catch(() => {});

  if (context.parsed.role === "tester" && context.issueRuntime?.infraFailCount) {
    await updateIssueRuntime(opts.workspaceDir, context.projectSlug, context.issueId, {
      infraFailCount: 0,
      inconclusiveCompletionAt: null,
      inconclusiveCompletionReason: null,
    }).catch(() => {});
  } else {
    await updateIssueRuntime(opts.workspaceDir, context.projectSlug, context.issueId, {
      inconclusiveCompletionAt: null,
      inconclusiveCompletionReason: null,
    }).catch(() => {});
  }

  return { applied: true };
}

export async function handleWorkerAgentEnd(opts: {
  sessionKey: string;
  runId?: string;
  messages?: unknown[];
  workspaceDir: string;
  runCommand: RunCommand;
  runtime?: RuntimeLike;
  pluginConfig?: FabricaPluginConfig;
  providerOverride?: IssueProvider;
  validateDeveloperDone?: (opts: {
    issueId: number;
    repoPath: string;
    provider: IssueProvider;
    runCommand: RunCommand;
    workspaceDir: string;
    projectSlug: string;
    issueRuntime?: ReturnType<typeof getIssueRuntime>;
  }) => Promise<DeveloperDoneValidationResult>;
}): Promise<WorkerCompletionOutcome | null> {
  const parsed = parseFabricaSessionKey(opts.sessionKey);
  const role = parsed ? asWorkerRole(parsed.role) : null;
  if (!parsed || !role || role === "reviewer") return null;

  const observation = await resolveWorkerResultFromRuntime(role, opts.sessionKey, opts.messages, opts.runtime);
  const context = await resolveWorkerSessionContext(opts.sessionKey, opts.workspaceDir);
  const ownership = await ensureCurrentWorkerDispatch({
    context,
    workspaceDir: opts.workspaceDir,
    sessionKey: opts.sessionKey,
    role,
    runId: opts.runId,
  });
  if (ownership) return ownership;

  if (context && observation.activityObserved) {
    await recordIssueLifecycle({
      workspaceDir: opts.workspaceDir,
      slug: context.projectSlug,
      issueId: context.issueId,
      stage: "first_worker_activity",
      sessionKey: opts.sessionKey,
      details: { role, source: "agent_end" },
    }).catch(() => {});
  }

  if (!observation.result) {
    if (observation.executionContractViolation) {
      if (context) {
        await updateIssueRuntime(opts.workspaceDir, context.projectSlug, context.issueId, {
          inconclusiveCompletionAt: new Date().toISOString(),
          inconclusiveCompletionReason: "invalid_execution_path",
        }).catch(() => {});
        await auditLog(opts.workspaceDir, "worker_completion_inconclusive", {
          sessionKey: opts.sessionKey,
          projectSlug: context.projectSlug,
          issueId: context.issueId,
          role,
          reason: "invalid_execution_path",
          violationReason: observation.executionContractViolation.reason,
          evidence: observation.executionContractViolation.evidence,
        }).catch(() => {});
      } else {
        await auditLog(opts.workspaceDir, "worker_result_skipped", {
          sessionKey: opts.sessionKey,
          role,
          reason: "invalid_execution_path",
          violationReason: observation.executionContractViolation.reason,
          evidence: observation.executionContractViolation.evidence,
        }).catch(() => {});
      }
      return { applied: false, reason: "invalid_execution_path" };
    }

    if (context && observation.activityObserved) {
      await updateIssueRuntime(opts.workspaceDir, context.projectSlug, context.issueId, {
        inconclusiveCompletionAt: new Date().toISOString(),
        inconclusiveCompletionReason: "missing_result_line",
      }).catch(() => {});
      await auditLog(opts.workspaceDir, "worker_completion_inconclusive", {
        sessionKey: opts.sessionKey,
        projectSlug: context.projectSlug,
        issueId: context.issueId,
        role,
        reason: "missing_result_line",
      }).catch(() => {});
      return { applied: false, reason: "inconclusive_completion" };
    }

    await auditLog(opts.workspaceDir, "worker_result_skipped", {
      sessionKey: opts.sessionKey,
      role,
      reason: "missing_result_line",
    }).catch(() => {});
    return { applied: false, reason: "missing_result_line" };
  }

  if (!context || context.parsed.role === "reviewer") return null;

  return applyWorkerResult({
    context,
    result: observation.result,
    workspaceDir: opts.workspaceDir,
    runCommand: opts.runCommand,
    runId: opts.runId,
    runtime: opts.runtime,
    pluginConfig: opts.pluginConfig,
    providerOverride: opts.providerOverride,
    validateDeveloperDone: opts.validateDeveloperDone,
  });
}
