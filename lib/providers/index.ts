/**
 * Provider factory — auto-detects GitHub vs GitLab from git remote.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { IssueProvider } from "./provider.js";
import type { RunCommand } from "../context.js";
import { GitLabProvider } from "./gitlab.js";
import { GitHubProvider } from "./github.js";
import { resolveRepoPath } from "../projects/index.js";

export type ProviderOptions = {
  provider?: "gitlab" | "github";
  repo?: string;
  repoPath?: string;
  runCommand: RunCommand;
  pluginConfig?: Record<string, unknown>;
  providerProfile?: string;
};

export type ProviderWithType = {
  provider: IssueProvider;
  type: "github" | "gitlab";
};

/**
 * Detect provider by reading .git/config directly — avoids relying on
 * runCommand with cwd support (gateway exec may not pass cwd to subprocess).
 */
async function detectProvider(repoPath: string, runCommand: RunCommand): Promise<"gitlab" | "github"> {
  // Primary: read .git/config directly (no subprocess, no cwd dependency)
  try {
    const gitConfig = await fs.readFile(path.join(repoPath, ".git", "config"), "utf-8");
    if (gitConfig.includes("github.com")) return "github";
    if (gitConfig.includes("gitlab.com")) return "gitlab";
  } catch {
    // File unreadable — fall through to subprocess
  }
  // Fallback: try subprocess (may fail if runCommand ignores cwd)
  try {
    const result = await runCommand(["git", "remote", "get-url", "origin"], { timeoutMs: 5_000, cwd: repoPath });
    return result.stdout.trim().includes("github.com") ? "github" : "gitlab";
  } catch {
    // Default to github — most likely provider in this environment
    return "github";
  }
}

export async function createProvider(opts: ProviderOptions): Promise<ProviderWithType> {
  const repoPath = opts.repoPath ?? (opts.repo ? resolveRepoPath(opts.repo) : null);
  if (!repoPath) throw new Error("Either repoPath or repo must be provided");
  const rc = opts.runCommand;
  const type = opts.provider ?? await detectProvider(repoPath, rc);
  const provider = type === "github"
    ? new GitHubProvider({
        repoPath,
        runCommand: rc,
        pluginConfig: opts.pluginConfig,
        providerProfile: opts.providerProfile,
      })
    : new GitLabProvider({ repoPath, runCommand: rc });
  return { provider, type };
}
