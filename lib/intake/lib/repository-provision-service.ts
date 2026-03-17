import fs from "node:fs/promises";
import path from "node:path";
import type {
  GenesisPayload,
  RepositoryProvisioning,
  RepositoryProvisioningMode,
  ScaffoldPlan,
  StepContext,
} from "../types.js";
import { buildScaffoldPlan } from "./scaffold-service.js";
import { GitHubProvider } from "../../providers/github.js";

type GitHubTarget = {
  owner: string;
  name: string;
  remoteUrl: string;
};

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function parseGitHubRemote(raw: string | null | undefined): GitHubTarget | null {
  const value = normalizeText(raw);
  if (!value) return null;
  const stripped = value
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^ssh:\/\/git@github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/^git:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const parts = stripped.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return {
    owner: parts[0]!,
    name: parts[1]!,
    remoteUrl: `https://github.com/${parts[0]}/${parts[1]}`,
  };
}

function adaptRunCommand(ctx: StepContext): import("../../context.js").RunCommand {
  return async (argv, options) => {
    const [cmd, ...args] = argv;
    const commandOptions = typeof options === "number" ? { timeoutMs: options } : options;
    const result = await ctx.runCommand(cmd ?? "", args, {
      timeout: commandOptions?.timeoutMs,
      cwd: commandOptions?.cwd,
      env: commandOptions?.env as Record<string, string | undefined> | undefined,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.exitCode,
      signal: null,
      killed: false,
      termination: "exit",
    };
  };
}

async function pathExists(candidate: string | null | undefined): Promise<boolean> {
  if (!candidate) return false;
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepository(candidate: string | null | undefined): Promise<boolean> {
  if (!candidate) return false;
  return pathExists(path.join(candidate, ".git"));
}

async function resolveLocalRepoRemote(ctx: StepContext, repoPath: string): Promise<string | null> {
  const result = await ctx.runCommand("git", ["remote", "get-url", "origin"], {
    timeout: 5_000,
    cwd: repoPath,
  }).catch(() => null);
  const remote = result?.stdout?.trim();
  return remote || null;
}

async function resolveRepositoryTarget(
  payload: GenesisPayload,
  ctx: StepContext,
): Promise<{
  mode: RepositoryProvisioningMode;
  remote: GitHubTarget | null;
  localPath: string | null;
  defaultBranch: string;
  plan?: ScaffoldPlan;
}> {
  const repoPath = normalizeText(payload.metadata.repo_path);
  const repoUrl = normalizeText(payload.metadata.repo_url);

  if (payload.project_map?.is_greenfield) {
    const plan = payload.metadata.scaffold_plan ?? await buildScaffoldPlan(payload, ctx);
    return {
      mode: "greenfield",
      remote: parseGitHubRemote(plan.repo_url),
      localPath: plan.repo_local,
      defaultBranch: "main",
      plan,
    };
  }

  if (repoPath) {
    const localRemote = await resolveLocalRepoRemote(ctx, repoPath);
    const remote = parseGitHubRemote(repoUrl)
      ?? parseGitHubRemote(localRemote);
    const explicitRemote = parseGitHubRemote(repoUrl);
    if (explicitRemote && localRemote) {
      const normalizedLocal = parseGitHubRemote(localRemote);
      if (normalizedLocal && normalizedLocal.remoteUrl !== explicitRemote.remoteUrl) {
        return {
          mode: "existing_local",
          remote: explicitRemote,
          localPath: repoPath,
          defaultBranch: "main",
        };
      }
    }
    return {
      mode: "existing_local",
      remote,
      localPath: repoPath,
      defaultBranch: "main",
    };
  }

  if (repoUrl) {
    const remote = parseGitHubRemote(repoUrl);
    const localPath = remote ? path.join(ctx.homeDir, "git", remote.owner, remote.name) : null;
    return {
      mode: "remote_only",
      remote,
      localPath,
      defaultBranch: "main",
    };
  }

  return {
    mode: "existing_local",
    remote: null,
    localPath: null,
    defaultBranch: "main",
  };
}

export async function ensureRepositoryProvisioning(
  payload: GenesisPayload,
  ctx: StepContext,
): Promise<RepositoryProvisioning> {
  const target = await resolveRepositoryTarget(payload, ctx);

  if (target.mode === "existing_local" && target.localPath) {
    const remoteUrl = target.remote?.remoteUrl
      ?? await resolveLocalRepoRemote(ctx, target.localPath);
    const repoReady = await isGitRepository(target.localPath);
    const actualRemote = await resolveLocalRepoRemote(ctx, target.localPath);
    const actualParsed = parseGitHubRemote(actualRemote);
    if (target.remote && actualParsed && actualParsed.remoteUrl !== target.remote.remoteUrl) {
      return {
        ready: false,
        provider: "github",
        mode: target.mode,
        repo_url: target.remote.remoteUrl,
        repo_local: target.localPath,
        default_branch: target.defaultBranch,
        created: false,
        cloned: false,
        seeded: false,
        reason: "local_repo_origin_mismatch",
      };
    }
    return {
      ready: repoReady,
      provider: target.remote ? "github" : "unknown",
      mode: target.mode,
      repo_url: remoteUrl,
      repo_local: target.localPath,
      default_branch: target.defaultBranch,
      created: false,
      cloned: false,
      seeded: false,
      reason: repoReady ? undefined : "local_repo_not_initialized",
    };
  }

  if (!target.remote || !target.localPath) {
    return {
      ready: false,
      provider: "unknown",
      mode: target.mode,
      repo_url: payload.metadata.repo_url ?? null,
      repo_local: payload.metadata.repo_path ?? null,
      default_branch: target.defaultBranch,
      reason: "repository_target_unresolved",
    };
  }

  const provider = new GitHubProvider({
    repoPath: target.localPath,
    runCommand: adaptRunCommand(ctx),
    pluginConfig: ctx.pluginConfig,
  });
  const description = normalizeText(payload.spec?.objective)
    ?? normalizeText(payload.raw_idea)
    ?? "Auto-provisioned by Fabrica";
  const result = await provider.ensureRepository({
    owner: target.remote.owner,
    name: target.remote.name,
    remoteUrl: target.remote.remoteUrl,
    defaultBranch: target.defaultBranch,
    description: description ?? undefined,
    visibility: "private",
  });

  return {
    ready: true,
    provider: "github",
    mode: target.mode,
    repo_url: result.repoUrl,
    repo_local: result.repoPath,
    default_branch: result.defaultBranch,
    created: result.created,
    cloned: result.cloned,
    seeded: result.seeded,
  };
}
