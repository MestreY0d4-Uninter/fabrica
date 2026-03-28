import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import type { GitHubAppProfileConfig } from "../config/types.js";
import {
  resolveGitHubAppId,
  resolveGitHubAuthProfile,
  resolveGitHubPrivateKey,
} from "./config-credentials.js";

const appCache = new Map<string, App>();

function cacheKey(appId: string, baseUrl?: string): string {
  return `${appId}|${baseUrl ?? ""}`;
}

function createApp(profile: GitHubAppProfileConfig, appId: string, privateKey: string): App {
  if (profile.baseUrl) {
    const BaseUrlOctokit = Octokit.defaults({ baseUrl: profile.baseUrl.replace(/\/+$/, "") });
    return new App({ appId, privateKey, Octokit: BaseUrlOctokit });
  }
  return new App({ appId, privateKey });
}

export function getGitHubAppProfile(pluginConfig: Record<string, unknown> | undefined): GitHubAppProfileConfig | null {
  return resolveGitHubAuthProfile(pluginConfig);
}

export function getGitHubApp(
  pluginConfig: Record<string, unknown> | undefined,
): App | null {
  const profile = resolveGitHubAuthProfile(pluginConfig);
  if (!profile) return null;

  const appId = resolveGitHubAppId(profile);
  const privateKey = resolveGitHubPrivateKey(profile);
  if (!appId || !privateKey) return null;

  const key = cacheKey(appId, profile.baseUrl);
  let app = appCache.get(key);
  if (!app) {
    app = createApp(profile, appId, privateKey);
    appCache.set(key, app);
  }
  return app;
}

export async function getGitHubRepoInstallationOctokit(
  pluginConfig: Record<string, unknown> | undefined,
  repo: { owner: string; repo: string },
): Promise<{ installationId: number; octokit: any } | null> {
  const app = getGitHubApp(pluginConfig);
  if (!app) return null;

  // Try repo-level installation first (most specific)
  try {
    const response = await app.octokit.request("GET /repos/{owner}/{repo}/installation", repo);
    const installationId = Number(response.data?.id);
    if (Number.isInteger(installationId) && installationId > 0) {
      return {
        installationId,
        octokit: await app.getInstallationOctokit(installationId),
      };
    }
  } catch {
    // Repo-level installation not found — fall through to org-level fallback
  }

  // Fallback: try org-level installation (covers repos created after the App was installed
  // at the org level with "All repositories" or when the repo was added later)
  try {
    const orgResponse = await app.octokit.request("GET /orgs/{org}/installation", { org: repo.owner });
    const installationId = Number(orgResponse.data?.id);
    if (Number.isInteger(installationId) && installationId > 0) {
      return {
        installationId,
        octokit: await app.getInstallationOctokit(installationId),
      };
    }
  } catch {
    // Org-level installation not found either
  }

  return null;
}

export async function getGitHubInstallationOctokit(
  pluginConfig: Record<string, unknown> | undefined,
  installationId: number,
): Promise<any | null> {
  const app = getGitHubApp(pluginConfig);
  if (!app) return null;
  return app.getInstallationOctokit(installationId);
}
