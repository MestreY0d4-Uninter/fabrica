import fs from "node:fs/promises";
import path from "node:path";
import type { GenesisPayload, ProjectMap } from "../types.js";
import { readProjects, resolveRepoPath } from "../../projects/io.js";
import type { Project } from "../../projects/types.js";

type ProjectWithLegacyFields = Project & {
  projectKind?: string;
  archived?: boolean;
};

type ResolvedProjectTarget = {
  project: ProjectWithLegacyFields | null;
  repo_url: string | null;
  repo_path: string | null;
  project_slug: string | null;
  project_name: string | null;
  project_kind: string | null;
  repo_target_source: string | null;
  archived: boolean;
  is_greenfield: boolean;
  remote_only: boolean;
  confidence: "high" | "low";
};

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".openclaw",
]);

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".java": "Java",
  ".rs": "Rust",
  ".nix": "Nix",
  ".sh": "Shell",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".json": "JSON",
  ".md": "Markdown",
};

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeRepoRemote(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  return normalized.replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
}

function parseOwnerRepo(raw: string | null | undefined): string | null {
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
  return `${parts[0]}/${parts[1]}`;
}

function normalizeRepoUrl(raw: string | null | undefined): string | null {
  const ownerRepo = parseOwnerRepo(raw);
  if (!ownerRepo) return normalizeText(raw);
  return `https://github.com/${ownerRepo}.git`;
}

function repoNameFromRepoUrl(raw: string | null | undefined): string | null {
  const ownerRepo = parseOwnerRepo(raw);
  if (!ownerRepo) return null;
  const [, repo] = ownerRepo.split("/");
  return repo || null;
}

function expandPath(raw: string | null | undefined, homeDir: string): string | null {
  const normalized = normalizeText(raw);
  if (!normalized) return null;
  if (normalized === "~") return homeDir;
  if (normalized.startsWith("~/")) return path.join(homeDir, normalized.slice(2));
  return normalized;
}

function extractRepoTarget(payload: GenesisPayload): string | null {
  const direct = normalizeText(payload.answers.repo_target);
  if (direct) return direct;

  const answersJson = payload.metadata.answers_json;
  if (answersJson && typeof answersJson === "object" && !Array.isArray(answersJson)) {
    const repoTarget = normalizeText(String((answersJson as Record<string, unknown>).repo_target ?? ""));
    if (repoTarget) return repoTarget;
  }

  return null;
}

function isFactoryProjectSlug(slug: string | null | undefined): boolean {
  if (!slug) return false;
  return /^(devclaw-automation|factory-|fabrica-|genesis-router)/i.test(slug);
}

function matchProjectByRef(projects: Record<string, ProjectWithLegacyFields>, ref: string): ProjectWithLegacyFields | null {
  const normalizedRef = ref.trim().toLowerCase();
  const ownerRepo = parseOwnerRepo(ref);
  const refRepoName = ownerRepo?.split("/")[1]?.toLowerCase() ?? normalizedRef;

  for (const [slug, project] of Object.entries(projects)) {
    const projectName = project.name?.toLowerCase() ?? "";
    const remote = normalizeRepoRemote(project.repoRemote);
    const remoteRepoName = repoNameFromRepoUrl(project.repoRemote)?.toLowerCase() ?? "";
    if (
      slug.toLowerCase() === normalizedRef ||
      projectName === normalizedRef ||
      remote === normalizeRepoRemote(ref) ||
      remoteRepoName === refRepoName
    ) {
      return project;
    }
  }

  return null;
}

async function tryStatDir(candidate: string | null): Promise<boolean> {
  if (!candidate) return false;
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function discoverLocalClone(repoUrl: string | null, homeDir: string): Promise<string | null> {
  const repoName = repoNameFromRepoUrl(repoUrl);
  if (!repoName) return null;
  const candidates = [
    path.join(homeDir, repoName),
    path.join(homeDir, "git", repoName),
    path.join(homeDir, "projects", repoName),
    path.join(homeDir, "code", repoName),
  ];

  for (const candidate of candidates) {
    if (await tryStatDir(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function resolveProjectTarget(
  payload: GenesisPayload,
  workspaceDir: string,
  homeDir: string,
): Promise<ResolvedProjectTarget> {
  let projects: Record<string, ProjectWithLegacyFields> = {};
  try {
    projects = (await readProjects(workspaceDir)).projects as Record<string, ProjectWithLegacyFields>;
  } catch {
    projects = {};
  }

  const explicitRepoUrl = normalizeRepoUrl(payload.metadata.repo_url);
  const explicitRepoPath = expandPath(payload.metadata.repo_path, homeDir);
  const explicitSlug = normalizeText(payload.metadata.project_slug);
  const explicitProjectName = normalizeText(payload.metadata.project_name);
  const repoTarget = extractRepoTarget(payload);

  let project: ProjectWithLegacyFields | null = null;
  let source: string | null = null;
  let repoUrl = explicitRepoUrl;
  let repoPath = explicitRepoPath;
  let projectSlug = explicitSlug;
  let projectName = explicitProjectName;

  if (explicitSlug && projects[explicitSlug]) {
    project = projects[explicitSlug]!;
    source = "metadata.project_slug";
  }

  if (!project && explicitRepoUrl) {
    project = matchProjectByRef(projects, explicitRepoUrl);
    if (project) source = "metadata.repo_url";
  }

  if (!project && explicitProjectName) {
    project = matchProjectByRef(projects, explicitProjectName);
    if (project) source = "metadata.project_name";
  }

  if (!project && repoTarget) {
    project = matchProjectByRef(projects, repoTarget);
    if (project) source = "answers.repo_target";
  }

  if (project) {
    projectSlug = project.slug;
    projectName = project.name;
    repoUrl = normalizeRepoUrl(project.repoRemote) ?? explicitRepoUrl;
    repoPath = resolveRepoPath(project.repo);
  } else if (!repoUrl && repoTarget) {
    repoUrl = normalizeRepoUrl(repoTarget);
    if (repoUrl) {
      source = "answers.repo_target";
      projectName = projectName ?? repoNameFromRepoUrl(repoUrl);
    }
  }

  if (!repoPath && repoUrl) {
    repoPath = await discoverLocalClone(repoUrl, homeDir);
  }

  const projectKind = project?.projectKind ?? "implementation";
  const archived = Boolean(project?.archived || projectKind === "archived_duplicate");

  if (projectSlug && isFactoryProjectSlug(projectSlug) && !payload.metadata.factory_change) {
    throw new Error(
      `Target project "${projectSlug}" is reserved for Fabrica-internal changes. Set factory_change=true to continue.`,
    );
  }

  if (projectSlug && repoPath && !(await tryStatDir(repoPath))) {
    throw new Error(
      `Registered project "${projectSlug}" resolved to local path "${repoPath}", but that directory does not exist.`,
    );
  }

  const hasRepoPath = await tryStatDir(repoPath);
  const hasRepoUrl = Boolean(repoUrl);

  return {
    project,
    repo_url: repoUrl,
    repo_path: hasRepoPath ? repoPath : null,
    project_slug: projectSlug,
    project_name: projectName ?? projectSlug ?? repoNameFromRepoUrl(repoUrl),
    project_kind: projectKind,
    repo_target_source: source,
    archived,
    is_greenfield: !hasRepoPath && !hasRepoUrl,
    remote_only: !hasRepoPath && hasRepoUrl,
    confidence: project || hasRepoPath ? "high" : hasRepoUrl ? "low" : "high",
  };
}

async function collectFiles(root: string, relativeDir = "", files: string[] = [], limit = 800): Promise<string[]> {
  if (files.length >= limit) return files;
  const currentDir = path.join(root, relativeDir);
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (files.length >= limit) break;
    if (entry.name.startsWith(".") && entry.name !== ".env.example") {
      if (entry.name !== ".github") continue;
    }

    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await collectFiles(root, relativePath, files, limit);
      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

function detectLanguages(files: string[]): string[] {
  const languages = new Set<string>();
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const language = EXTENSION_LANGUAGE_MAP[ext];
    if (language) languages.add(language);
  }
  return [...languages].sort();
}

function collectModules(files: string[]): string[] {
  const modules = new Set<string>();
  for (const file of files) {
    const parts = file.split(path.sep).filter(Boolean);
    if (parts.length > 1) {
      modules.add(parts[0]!);
      continue;
    }
    const stem = path.basename(file, path.extname(file));
    if (stem && !["readme", "license", "package", "tsconfig", "go.mod", "flake"].includes(stem.toLowerCase())) {
      modules.add(stem);
    }
  }
  return [...modules].sort();
}

function collectSymbols(files: string[]): ProjectMap["symbols"] {
  const symbols = new Map<string, ProjectMap["symbols"][number]>();
  for (const file of files) {
    const stem = path.basename(file, path.extname(file));
    if (stem && !symbols.has(`${file}:${stem}`)) {
      symbols.set(`${file}:${stem}`, {
        name: stem,
        kind: "file",
        file,
      });
    }

    const dir = path.dirname(file);
    if (dir && dir !== ".") {
      const parts = dir.split(path.sep).filter(Boolean);
      for (const part of parts.slice(0, 2)) {
        const key = `${file}:${part}:module`;
        if (!symbols.has(key)) {
          symbols.set(key, {
            name: part,
            kind: "module",
            file,
          });
        }
      }
    }
  }

  return [...symbols.values()].slice(0, 400);
}

export async function buildProjectMap(
  resolved: ResolvedProjectTarget,
): Promise<ProjectMap> {
  if (resolved.is_greenfield) {
    return {
      version: "ts-1",
      project: resolved.project_name ?? "greenfield",
      root: null,
      repo_url: resolved.repo_url,
      is_greenfield: true,
      remote_only: false,
      confidence: "high",
      project_slug: resolved.project_slug,
      project_kind: resolved.project_kind,
      archived: resolved.archived,
      modules: [],
      note: "No existing project target resolved; treating intake as greenfield.",
      stats: {
        languages: [],
        symbol_count: 0,
        files_scanned: 0,
      },
      symbols: [],
    };
  }

  if (!resolved.repo_path) {
    return {
      version: "ts-1",
      project: resolved.project_name ?? resolved.project_slug ?? "remote-project",
      root: null,
      repo_url: resolved.repo_url,
      is_greenfield: false,
      remote_only: true,
      confidence: "low",
      project_slug: resolved.project_slug,
      project_kind: resolved.project_kind,
      archived: resolved.archived,
      modules: [],
      note: "Existing project resolved only by remote metadata; local repository scan unavailable.",
      stats: {
        languages: [],
        symbol_count: 0,
        files_scanned: 0,
      },
      symbols: [],
    };
  }

  const files = await collectFiles(resolved.repo_path);
  const languages = detectLanguages(files);
  const modules = collectModules(files);
  const symbols = collectSymbols(files);

  return {
    version: "ts-1",
    project: resolved.project_name ?? resolved.project_slug ?? path.basename(resolved.repo_path),
    root: resolved.repo_path,
    repo_url: resolved.repo_url,
    is_greenfield: false,
    remote_only: false,
    confidence: resolved.confidence,
    project_slug: resolved.project_slug,
    project_kind: resolved.project_kind,
    archived: resolved.archived,
    modules,
    stats: {
      languages,
      symbol_count: symbols.length,
      files_scanned: files.length,
    },
    symbols,
  };
}
