import type { IssueProvider, PrStatus } from "../providers/provider.js";
import type { RunCommand } from "../context.js";
import { log as auditLog } from "../audit.js";
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
import { resolveWorkerSlot, validatePrExistsForDeveloper } from "../tools/worker/work-finish.js";

type WorkerCompletionOutcome = { applied: boolean; reason?: string };

type RuntimeLike = {
  system?: { requestHeartbeatNow?: (opts: { reason: string; coalesceMs?: number }) => void };
};

type DeveloperDoneValidationResult = {
  ok: boolean;
  reason?: string;
  prStatus?: PrStatus;
};

type WorkerSessionContext = {
  parsed: { projectName: string; role: WorkerRole };
  projectSlug: string;
  project: Awaited<ReturnType<typeof readProjects>>["projects"][string];
  issueId: number;
  slotLevel: string;
  slotIndex: number;
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
    BLOCKED: "blocked",
  },
  architect: {
    DONE: "done",
    BLOCKED: "blocked",
  },
};

function asWorkerRole(role: string): WorkerRole | null {
  return role === "developer" || role === "tester" || role === "architect" || role === "reviewer"
    ? role
    : null;
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
    parsed: {
      projectName: parsed.projectName,
      role,
    },
    projectSlug,
    project,
    issueId: slot.issueId,
    slotLevel: slot.slotLevel,
    slotIndex: slot.slotIndex,
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
  runtime?: RuntimeLike;
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
    sessionKey: context.project.workers[context.parsed.role]?.levels?.[context.slotLevel]?.[context.slotIndex]?.sessionKey ?? null,
    details: { role: context.parsed.role, result: completionResult, source: "agent_end" },
  }).catch(() => {});

  await auditLog(opts.workspaceDir, "worker_completion_applied", {
    sessionKey: context.project.workers[context.parsed.role]?.levels?.[context.slotLevel]?.[context.slotIndex]?.sessionKey ?? null,
    projectSlug: context.projectSlug,
    issueId: context.issueId,
    role: context.parsed.role,
    result: opts.result.value,
    source: opts.result.source,
  }).catch(() => {});

  return { applied: true };
}

export async function handleWorkerAgentEnd(opts: {
  sessionKey: string;
  messages?: unknown[];
  workspaceDir: string;
  runCommand: RunCommand;
  runtime?: RuntimeLike;
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

  const result = extractWorkerResultFromMessages(role, opts.messages ?? []);
  if (!result) {
    await auditLog(opts.workspaceDir, "worker_result_skipped", {
      sessionKey: opts.sessionKey,
      role,
      reason: "missing_result_line",
    }).catch(() => {});
    return { applied: false, reason: "missing_result_line" };
  }

  const context = await resolveWorkerSessionContext(opts.sessionKey, opts.workspaceDir);
  if (!context || context.parsed.role === "reviewer") return null;

  return applyWorkerResult({
    context,
    result,
    workspaceDir: opts.workspaceDir,
    runCommand: opts.runCommand,
    runtime: opts.runtime,
    providerOverride: opts.providerOverride,
    validateDeveloperDone: opts.validateDeveloperDone,
  });
}
