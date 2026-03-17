import { log as auditLog } from "../audit.js";
import { readProjects } from "./io.js";
import { getIssueRuntime, updateIssueRuntime } from "./mutations.js";
import type { IssueRuntimeState, ProjectsData } from "./types.js";

export type IssueLifecycleStage =
  | "dispatch_requested"
  | "session_patched"
  | "agent_accepted"
  | "first_worker_activity"
  | "session_completed";

type LifecycleResolution = {
  slug: string;
  issueId: number;
  runtime: IssueRuntimeState | undefined;
};

const STAGE_FIELD: Record<IssueLifecycleStage, keyof IssueRuntimeState> = {
  dispatch_requested: "dispatchRequestedAt",
  session_patched: "sessionPatchedAt",
  agent_accepted: "agentAcceptedAt",
  first_worker_activity: "firstWorkerActivityAt",
  session_completed: "sessionCompletedAt",
};

function findIssueBySessionKey(data: ProjectsData, sessionKey: string): LifecycleResolution | null {
  for (const [slug, project] of Object.entries(data.projects)) {
    for (const worker of Object.values(project.workers ?? {})) {
      for (const slots of Object.values(worker.levels ?? {})) {
        for (const slot of slots) {
          if (slot.sessionKey !== sessionKey) continue;
          const issueId = slot.issueId ?? slot.lastIssueId;
          if (!issueId) continue;
          return {
            slug,
            issueId: Number(issueId),
            runtime: getIssueRuntime(project, issueId),
          };
        }
      }
    }

    for (const [issueId, runtime] of Object.entries(project.issueRuntime ?? {})) {
      if (runtime.lastSessionKey === sessionKey) {
        return {
          slug,
          issueId: Number(issueId),
          runtime,
        };
      }
    }
  }

  return null;
}

function buildLifecycleUpdates(
  stage: IssueLifecycleStage,
  runtime: IssueRuntimeState | undefined,
  timestamp: string,
  sessionKey?: string | null,
): { updates: Partial<IssueRuntimeState>; shouldWrite: boolean } {
  const field = STAGE_FIELD[stage];
  const existing = runtime?.[field] ?? null;

  if (stage === "dispatch_requested") {
    return {
      shouldWrite: true,
      updates: {
        dispatchRequestedAt: runtime?.dispatchRequestedAt ?? timestamp,
        lastSessionKey: sessionKey ?? runtime?.lastSessionKey ?? null,
      },
    };
  }

  if (existing) {
    return {
      shouldWrite: false,
      updates: {},
    };
  }

  return {
    shouldWrite: true,
    updates: {
      [field]: timestamp,
      ...(sessionKey ? { lastSessionKey: sessionKey } : {}),
    },
  };
}

export async function recordIssueLifecycle(params: {
  workspaceDir: string;
  slug: string;
  issueId: number;
  stage: IssueLifecycleStage;
  sessionKey?: string | null;
  details?: Record<string, unknown>;
}): Promise<boolean> {
  const { workspaceDir, slug, issueId, stage, sessionKey, details } = params;
  const data = await readProjects(workspaceDir);
  const project = data.projects[slug];
  const runtime = project ? getIssueRuntime(project, issueId) : undefined;
  const timestamp = new Date().toISOString();
  const { updates, shouldWrite } = buildLifecycleUpdates(stage, runtime, timestamp, sessionKey);

  if (!shouldWrite) return false;

  await updateIssueRuntime(workspaceDir, slug, issueId, updates);
  await auditLog(workspaceDir, stage, {
    projectSlug: slug,
    issueId,
    sessionKey: sessionKey ?? null,
    ...details,
  }).catch(() => {});
  return true;
}

export async function recordIssueLifecycleBySessionKey(params: {
  workspaceDir: string;
  sessionKey?: string | null;
  stage: IssueLifecycleStage;
  details?: Record<string, unknown>;
}): Promise<boolean> {
  if (!params.sessionKey) return false;
  const data = await readProjects(params.workspaceDir);
  const resolved = findIssueBySessionKey(data, params.sessionKey);
  if (!resolved) return false;
  return recordIssueLifecycle({
    workspaceDir: params.workspaceDir,
    slug: resolved.slug,
    issueId: resolved.issueId,
    stage: params.stage,
    sessionKey: params.sessionKey,
    details: params.details,
  });
}
