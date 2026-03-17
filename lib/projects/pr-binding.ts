import { readProjects } from "./io.js";
import { getIssueRuntime, updateIssueRuntime } from "./mutations.js";
import type { IssueRuntimeState, Project, ProjectsData } from "./types.js";
import type { PrSelector } from "../providers/provider.js";

export type CanonicalPrIdentity = {
  installationId: number;
  repositoryId: number;
  prNumber: number;
  headSha?: string | null;
};

export type CanonicalPrBinding = {
  slug: string;
  issueId: number;
  project: Project;
  runtime: IssueRuntimeState;
};

function isSamePr(runtime: IssueRuntimeState, identity: CanonicalPrIdentity): boolean {
  if (!runtime.currentPrNumber) return false;
  if (runtime.currentPrNumber !== identity.prNumber) return false;
  if (runtime.currentPrInstallationId && runtime.currentPrInstallationId !== identity.installationId) return false;
  if (runtime.currentPrRepositoryId && runtime.currentPrRepositoryId !== identity.repositoryId) return false;
  return true;
}

function isOpenRuntime(runtime: IssueRuntimeState | undefined): boolean {
  const state = runtime?.currentPrState?.toLowerCase();
  if (!state) return false;
  return state !== "closed" && state !== "merged" && state !== "aborted";
}

export function findCanonicalPrBindingInData(
  data: ProjectsData,
  identity: CanonicalPrIdentity,
): CanonicalPrBinding | null {
  const matches: CanonicalPrBinding[] = [];
  for (const [slug, project] of Object.entries(data.projects)) {
    for (const [issueId, runtime] of Object.entries(project.issueRuntime ?? {})) {
      if (!isSamePr(runtime, identity)) continue;
      matches.push({
        slug,
        issueId: Number(issueId),
        project,
        runtime,
      });
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    // Multi-match: log warning but return first match
    console.warn(
      `[fabrica:pr-binding] WARNING: PR #${identity.prNumber} (repo ${identity.repositoryId}) matched ${matches.length} project bindings: ${matches.map((m) => `${m.slug}#${m.issueId}`).join(", ")}. Using first match.`
    );
  }
  return matches[0]!;
}

export async function findCanonicalPrBinding(
  workspaceDir: string,
  identity: CanonicalPrIdentity,
): Promise<CanonicalPrBinding | null> {
  const data = await readProjects(workspaceDir);
  return findCanonicalPrBindingInData(data, identity);
}

export function canBindIssueToPr(
  project: Project,
  issueId: number,
  identity: CanonicalPrIdentity,
): boolean {
  const runtime = getIssueRuntime(project, issueId);
  if (!runtime?.currentPrNumber) return true;
  if (isSamePr(runtime, identity)) return true;
  return !isOpenRuntime(runtime);
}

export async function releaseCanonicalPrBinding(params: {
  workspaceDir: string;
  slug: string;
  issueId: number;
  identity: CanonicalPrIdentity;
  deliveryId: string;
  reason: "retargeted" | "replaced";
  nextIssueTarget?: number | null;
}): Promise<void> {
  const runtime = (await readProjects(params.workspaceDir)).projects[params.slug]?.issueRuntime?.[String(params.issueId)];
  if (!runtime || !isSamePr(runtime, params.identity)) return;

  await updateIssueRuntime(params.workspaceDir, params.slug, params.issueId, {
    currentPrNumber: null,
    currentPrNodeId: null,
    currentPrUrl: null,
    currentPrState: null,
    currentPrInstallationId: null,
    currentPrRepositoryId: null,
    currentPrHeadSha: params.identity.headSha ?? runtime.currentPrHeadSha ?? null,
    currentPrSourceBranch: null,
    currentPrIssueTarget: null,
    lastRejectedPrNumber: params.identity.prNumber,
    lastResolvedIssueTarget: params.nextIssueTarget ?? runtime.lastResolvedIssueTarget ?? null,
    lastGitHubDeliveryId: params.deliveryId,
    followUpPrRequired: params.reason === "retargeted" ? true : runtime.followUpPrRequired,
    bindingSource: "repaired",
    bindingConfidence: "low",
    boundAt: new Date().toISOString(),
  });
}

export function getCanonicalPrSelector(
  project: Project,
  issueId: number | string,
): PrSelector | undefined {
  const issueRuntime = getIssueRuntime(project, issueId);
  if (!issueRuntime?.currentPrNumber) return undefined;
  return { prNumber: issueRuntime.currentPrNumber };
}

export function requireCanonicalPrSelector(
  project: Project,
  issueId: number | string,
  consumer: string,
): PrSelector {
  const selector = getCanonicalPrSelector(project, issueId);
  if (!selector?.prNumber) {
    throw new Error(
      `Cannot ${consumer} for issue #${issueId} without a canonical bound PR. ` +
      `Return the issue to follow-up and open a dedicated PR first.`,
    );
  }
  return selector;
}
