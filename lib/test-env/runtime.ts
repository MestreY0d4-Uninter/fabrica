import type { RunCommand } from "../context.js";
import type { CanonicalStack } from "../intake/types.js";
import type { Project, ProjectEnvironmentState } from "../projects/types.js";
import { resolveRepoPath } from "../projects/index.js";
import { updateProjectEnvironment } from "../projects/mutations.js";
import { log as auditLog } from "../audit.js";
import { ensureProjectTestEnvironment, type BootstrapMode } from "./bootstrap.js";
import { resolveStackEnvironmentContract } from "./contracts.js";
import { getProjectEnvironmentState } from "./state.js";

function projectEnvironmentStateFor(
  project: Project,
  stack: CanonicalStack,
  updates: Partial<ProjectEnvironmentState>,
): ProjectEnvironmentState {
  const current = getProjectEnvironmentState(project, stack);
  return getProjectEnvironmentState({
    ...project,
    environment: {
      ...current,
      ...updates,
    },
  }, stack);
}

export async function ensureEnvironmentReady(opts: {
  workspaceDir: string;
  projectSlug: string;
  project: Project;
  stack: CanonicalStack;
  mode: Extract<BootstrapMode, "developer" | "tester">;
  runCommand: RunCommand;
}): Promise<{ ready: boolean; state: ProjectEnvironmentState }> {
  const contract = resolveStackEnvironmentContract(opts.stack);
  const current = getProjectEnvironmentState(opts.project, opts.stack);

  if (current.status === "ready") {
    return { ready: true, state: current };
  }

  if (
    (current.status === "failed" || current.status === "provisioning") &&
    current.nextProvisionRetryAt &&
    Date.parse(current.nextProvisionRetryAt) > Date.now()
  ) {
    return { ready: false, state: current };
  }

  await updateProjectEnvironment(opts.workspaceDir, opts.projectSlug, {
    status: "provisioning",
    stack: opts.stack,
    contractVersion: contract.version,
    lastProvisionError: null,
  });
  await auditLog(opts.workspaceDir, "environment_bootstrap_started", {
    projectSlug: opts.projectSlug,
    stack: opts.stack,
    contractVersion: contract.version,
  }).catch(() => {});

  const result = await ensureProjectTestEnvironment({
    repoPath: resolveRepoPath(opts.project.repo),
    stack: opts.stack,
    mode: opts.mode,
    runCommand: opts.runCommand,
  });

  if (!result.ready) {
    const nextRetryAt = new Date(Date.now() + 60_000).toISOString();
    const state = projectEnvironmentStateFor(opts.project, opts.stack, {
      status: "failed",
      stack: opts.stack,
      contractVersion: contract.version,
      lastProvisionError: result.reason ?? "environment_bootstrap_failed",
      nextProvisionRetryAt: nextRetryAt,
    });

    await updateProjectEnvironment(opts.workspaceDir, opts.projectSlug, {
      status: state.status,
      stack: state.stack,
      contractVersion: state.contractVersion,
      lastProvisionedAt: state.lastProvisionedAt,
      lastProvisionError: state.lastProvisionError,
      nextProvisionRetryAt: state.nextProvisionRetryAt,
    });
    await auditLog(opts.workspaceDir, "environment_bootstrap_retry_scheduled", {
      projectSlug: opts.projectSlug,
      stack: opts.stack,
      nextRetryAt,
      reason: state.lastProvisionError ?? "environment_bootstrap_failed",
    }).catch(() => {});

    return { ready: false, state };
  }

  const provisionedAt = new Date().toISOString();
  const state = projectEnvironmentStateFor(opts.project, opts.stack, {
    status: "ready",
    stack: opts.stack,
    contractVersion: contract.version,
    lastProvisionedAt: provisionedAt,
    lastProvisionError: null,
    nextProvisionRetryAt: null,
  });

  await updateProjectEnvironment(opts.workspaceDir, opts.projectSlug, {
    status: state.status,
    stack: state.stack,
    contractVersion: state.contractVersion,
    lastProvisionedAt: state.lastProvisionedAt,
    lastProvisionError: state.lastProvisionError,
    nextProvisionRetryAt: state.nextProvisionRetryAt,
  });
  await auditLog(opts.workspaceDir, "environment_ready_confirmed", {
    projectSlug: opts.projectSlug,
    stack: opts.stack,
    contractVersion: contract.version,
  }).catch(() => {});

  return { ready: true, state };
}
