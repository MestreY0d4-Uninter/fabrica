import type { RunCommand } from "../context.js";
import type { CanonicalStack } from "../intake/types.js";
import type { Project, ProjectEnvironmentState } from "../projects/types.js";
import { resolveRepoPath } from "../projects/index.js";
import { updateProjectEnvironment } from "../projects/mutations.js";
import { log as auditLog } from "../audit.js";
import { ensureProjectTestEnvironment, type BootstrapMode } from "./bootstrap.js";
import { resolveStackEnvironmentContract } from "./contracts.js";
import { getProjectEnvironmentState } from "./state.js";

const STALE_PROVISIONING_WINDOW_MS = 10 * 60 * 1000;
const FAILED_RETRY_DELAY_MS = 60 * 1000;

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
  const retryAtMs = current.nextProvisionRetryAt ? Date.parse(current.nextProvisionRetryAt) : Number.NaN;

  if (current.status === "ready") {
    return { ready: true, state: current };
  }

  if (current.status === "provisioning") {
    const provisioningStartedAt = current.provisioningStartedAt
      ? Date.parse(current.provisioningStartedAt)
      : Number.NaN;
    const provisioningIsFresh = Number.isFinite(provisioningStartedAt)
      && (Date.now() - provisioningStartedAt) < STALE_PROVISIONING_WINDOW_MS;
    if (provisioningIsFresh) {
      await auditLog(opts.workspaceDir, "environment_bootstrap_blocked", {
        projectSlug: opts.projectSlug,
        stack: opts.stack,
        mode: opts.mode,
        status: current.status,
        reason: "provisioning_in_progress",
        provisioningStartedAt: current.provisioningStartedAt ?? null,
        contractVersion: current.contractVersion ?? contract.version,
      }).catch(() => {});
      return { ready: false, state: current };
    }
    await auditLog(opts.workspaceDir, "environment_bootstrap_retry_scheduled", {
      projectSlug: opts.projectSlug,
      stack: opts.stack,
      reason: "stale_provisioning_state",
      staleProvisioningStartedAt: current.provisioningStartedAt ?? null,
    }).catch(() => {});
  }

  if (
    current.status === "failed" &&
    current.nextProvisionRetryAt &&
    Number.isFinite(retryAtMs) &&
    retryAtMs > Date.now()
  ) {
    await auditLog(opts.workspaceDir, "environment_bootstrap_blocked", {
      projectSlug: opts.projectSlug,
      stack: opts.stack,
      mode: opts.mode,
      status: current.status,
      reason: "retry_backoff_active",
      blockedUntil: current.nextProvisionRetryAt,
      lastProvisionError: current.lastProvisionError ?? null,
      contractVersion: current.contractVersion ?? contract.version,
    }).catch(() => {});
    return { ready: false, state: current };
  }

  await updateProjectEnvironment(opts.workspaceDir, opts.projectSlug, {
    status: "provisioning",
    stack: opts.stack,
    contractVersion: contract.version,
    provisioningStartedAt: new Date().toISOString(),
    lastProvisionError: null,
    nextProvisionRetryAt: null,
  });
  await auditLog(opts.workspaceDir, "environment_bootstrap_started", {
    projectSlug: opts.projectSlug,
    stack: opts.stack,
    mode: opts.mode,
    previousStatus: current.status,
    contractVersion: contract.version,
  }).catch(() => {});

  const bootstrapRunCommand: Parameters<typeof ensureProjectTestEnvironment>[0]["runCommand"] = async (
    cmd,
    args,
    bootstrapOpts,
  ) => {
    const result = await opts.runCommand([cmd, ...args], {
      timeoutMs: typeof bootstrapOpts?.timeout === "number" ? bootstrapOpts.timeout : 60_000,
      cwd: bootstrapOpts?.cwd,
      env: bootstrapOpts?.env,
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: typeof result.code === "number" ? result.code : 0,
    };
  };

  const result = await ensureProjectTestEnvironment({
    repoPath: resolveRepoPath(opts.project.repo),
    stack: opts.stack,
    mode: opts.mode,
    runCommand: bootstrapRunCommand,
  }).catch((error: unknown) => ({
    ready: false as const,
    reason:
      error instanceof Error
        ? error.message
        : "environment_bootstrap_failed",
  }));

  if (!result.ready) {
    const nextRetryAt = new Date(Date.now() + FAILED_RETRY_DELAY_MS).toISOString();
    const state = projectEnvironmentStateFor(opts.project, opts.stack, {
      status: "failed",
      stack: opts.stack,
      contractVersion: contract.version,
      provisioningStartedAt: null,
      lastProvisionError: result.reason ?? "environment_bootstrap_failed",
      nextProvisionRetryAt: nextRetryAt,
    });

    await updateProjectEnvironment(opts.workspaceDir, opts.projectSlug, {
      status: state.status,
      stack: state.stack,
      contractVersion: state.contractVersion,
      provisioningStartedAt: state.provisioningStartedAt,
      lastProvisionedAt: state.lastProvisionedAt,
      lastProvisionError: state.lastProvisionError,
      nextProvisionRetryAt: state.nextProvisionRetryAt,
    });
    await auditLog(opts.workspaceDir, "environment_bootstrap_retry_scheduled", {
      projectSlug: opts.projectSlug,
      stack: opts.stack,
      mode: opts.mode,
      nextRetryAt,
      retryDelayMs: FAILED_RETRY_DELAY_MS,
      reason: state.lastProvisionError ?? "environment_bootstrap_failed",
      contractVersion: state.contractVersion ?? contract.version,
    }).catch(() => {});

    return { ready: false, state };
  }

  const provisionedAt = new Date().toISOString();
  const state = projectEnvironmentStateFor(opts.project, opts.stack, {
    status: "ready",
    stack: opts.stack,
    contractVersion: contract.version,
    provisioningStartedAt: null,
    lastProvisionedAt: provisionedAt,
    lastProvisionError: null,
    nextProvisionRetryAt: null,
  });

  await updateProjectEnvironment(opts.workspaceDir, opts.projectSlug, {
    status: state.status,
    stack: state.stack,
    contractVersion: state.contractVersion,
    provisioningStartedAt: state.provisioningStartedAt,
    lastProvisionedAt: state.lastProvisionedAt,
    lastProvisionError: state.lastProvisionError,
    nextProvisionRetryAt: state.nextProvisionRetryAt,
  });
  await auditLog(opts.workspaceDir, "environment_ready_confirmed", {
    projectSlug: opts.projectSlug,
    stack: opts.stack,
    mode: opts.mode,
    previousStatus: current.status,
    lastProvisionedAt: provisionedAt,
    contractVersion: contract.version,
  }).catch(() => {});

  return { ready: true, state };
}
