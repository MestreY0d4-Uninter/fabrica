import type { GenesisPayload } from "../types.js";

const REPO_NAME_BLOCKLIST = new Set([
  "novo",
  "new",
  "app",
  "api",
  "web",
  "test",
  "temp",
  "tmp",
  "projeto",
  "project",
  "demo",
  "sample",
  "example",
  "my-app",
  "my-project",
  "untitled",
  "criar",
  "create",
  "build",
  "greenfield",
]);

export function normalizeIntakeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function sanitizeRepoName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/[._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export function isValidRepoName(name: string): boolean {
  return name.length >= 3 && !REPO_NAME_BLOCKLIST.has(name);
}

export function parseOwnerRepo(raw: string | null | undefined): { owner: string; repo: string } | null {
  const normalized = normalizeIntakeText(raw);
  if (!normalized) return null;
  const stripped = normalized
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^ssh:\/\/git@github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/^git:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const parts = stripped.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

export function deriveRepoNameFromCandidates(
  candidates: Array<{ value: string | null | undefined; source: string }>,
  fallbackSeed: string,
): { repoName: string; source: string } {
  for (const candidate of candidates) {
    const raw = normalizeIntakeText(candidate.value);
    if (!raw) continue;
    const repoName = sanitizeRepoName(raw);
    if (isValidRepoName(repoName)) {
      return { repoName, source: candidate.source };
    }
  }

  const fallback = sanitizeRepoName(fallbackSeed);
  return {
    repoName: fallback || `genesis-${Date.now()}`,
    source: "fallback",
  };
}

export function deriveRepoName(
  payload: GenesisPayload,
  explicitRepoName: string | null,
): { repoName: string; source: string } {
  return deriveRepoNameFromCandidates([
    { value: explicitRepoName, source: "metadata.repo_url" },
    { value: payload.metadata.project_name, source: "metadata.project_name" },
    { value: payload.spec_data?.project_slug, source: "spec_data.project_slug" },
    { value: payload.project_map?.project_slug, source: "project_map.project_slug" },
    { value: payload.project_map?.project, source: "project_map.project" },
    { value: payload.spec?.title, source: "spec.title" },
    { value: payload.raw_idea, source: "raw_idea" },
  ], `genesis-${payload.session_id}`);
}

export function inferProjectNameFromIdea(text: string, repoUrl?: string | null): string | null {
  const fromRepo = parseOwnerRepo(repoUrl)?.repo ?? null;
  const derived = deriveRepoNameFromCandidates([
    { value: fromRepo, source: "repo_url" },
    { value: text, source: "raw_idea" },
  ], "project");
  return normalizeIntakeText(derived.repoName);
}
