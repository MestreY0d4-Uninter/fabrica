import { lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitHubAppProfileConfig, ProvidersConfig } from "../config/types.js";

const MAX_SECRET_FILE_BYTES = 128 * 1024;

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function expandUserPath(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function readConfiguredFile(filePath: string, _label: string): string | null {
  try {
    const resolvedPath = expandUserPath(filePath);
    const stat = lstatSync(resolvedPath);
    if (stat.isSymbolicLink()) {
      return null;
    }
    if (!stat.isFile()) {
      return null;
    }
    if (stat.size > MAX_SECRET_FILE_BYTES) {
      return null;
    }
    const value = readFileSync(resolvedPath, "utf-8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function normalizeMultilineSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/\\n/g, "\n") : null;
}

export function getGitHubProviderConfig(
  pluginConfig?: Record<string, unknown>,
): ProvidersConfig["github"] | undefined {
  return (pluginConfig as { providers?: ProvidersConfig } | undefined)?.providers?.github;
}

export function resolveGitHubAuthProfile(
  pluginConfig: Record<string, unknown> | undefined,
  profileName?: string,
): GitHubAppProfileConfig | null {
  const github = getGitHubProviderConfig(pluginConfig);
  const resolvedName = profileName ?? github?.defaultAuthProfile;
  if (!github?.authProfiles || !resolvedName) return null;
  const profile = github.authProfiles[resolvedName];
  if (!profile || profile.mode !== "github-app") return null;
  return profile;
}

export function resolveGitHubAppId(profile: GitHubAppProfileConfig): string | null {
  const direct = trimToUndefined(profile.appId);
  if (direct) return direct;
  const envValue = profile.appIdEnv ? trimToUndefined(process.env[profile.appIdEnv]) : undefined;
  return envValue ?? null;
}

export function resolveGitHubPrivateKey(profile: GitHubAppProfileConfig): string | null {
  const direct = normalizeMultilineSecret(trimToUndefined(profile.privateKey));
  if (direct) return direct;

  const configuredPath = trimToUndefined(profile.privateKeyPath);
  if (configuredPath) {
    return normalizeMultilineSecret(readConfiguredFile(configuredPath, "GitHub App private key"));
  }

  const envDirect = profile.privateKeyEnv
    ? normalizeMultilineSecret(trimToUndefined(process.env[profile.privateKeyEnv]))
    : null;
  if (envDirect) return envDirect;

  const envPath = profile.privateKeyPathEnv
    ? trimToUndefined(process.env[profile.privateKeyPathEnv])
    : undefined;
  if (envPath) {
    return normalizeMultilineSecret(readConfiguredFile(envPath, "GitHub App private key"));
  }

  return null;
}

export function resolveGitHubWebhookSecret(
  pluginConfig: Record<string, unknown> | undefined,
): string | null {
  const github = getGitHubProviderConfig(pluginConfig);
  const direct = normalizeMultilineSecret(trimToUndefined(github?.webhookSecret));
  if (direct) return direct;

  const configuredPath = trimToUndefined(github?.webhookSecretPath);
  if (configuredPath) {
    return normalizeMultilineSecret(readConfiguredFile(configuredPath, "GitHub webhook secret"));
  }

  const envSecret = github?.webhookSecretEnv
    ? normalizeMultilineSecret(trimToUndefined(process.env[github.webhookSecretEnv]))
    : null;
  return envSecret ?? null;
}
