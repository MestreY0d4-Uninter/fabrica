/**
 * projects/io.ts — File I/O and locking for projects.json.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { migrateProject } from "./migrations.js";
import { DATA_DIR } from "../setup/constants.js";
import { ensureWorkspaceMigrated } from "../setup/migrate-layout.js";
import { isLegacySchema, migrateLegacySchema } from "./schema-migration.js";
import type { ProjectsData, Project } from "./types.js";
import { findProjectByChannelId, findProjectByRoute, findProjectsByChannelId, isForumProject, type RouteRef } from "./routes.js";
import { backupFile, writeSafe, readJsonWithFallback } from "./io-helpers.js";


// ---------------------------------------------------------------------------
// File locking — prevents concurrent read-modify-write races
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;

export function lockPath(workspaceDir: string): string {
  return projectsPath(workspaceDir) + ".lock";
}

export async function acquireLock(workspaceDir: string): Promise<void> {
  const lock = lockPath(workspaceDir);
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      await fs.writeFile(lock, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), { flag: "wx" });
      return;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;

      // Check for stale lock with PID liveness
      try {
        const content = await fs.readFile(lock, "utf-8");
        let lockData: { pid?: number; timestamp?: number };
        try {
          lockData = JSON.parse(content);
        } catch {
          // Legacy format (plain timestamp string) — treat as stale with no PID
          lockData = { timestamp: parseInt(content, 10) };
        }

        const lockTime = lockData.timestamp ?? 0;
        const lockPid = lockData.pid;

        // Check if PID is alive
        let pidAlive = false;
        if (lockPid) {
          try {
            process.kill(lockPid, 0); // Signal 0 = existence check only
            pidAlive = true;
          } catch (killErr: unknown) {
            // ESRCH: process does not exist — truly dead
            // EPERM: process exists but different UID — treat as alive (conservative)
            pidAlive = (killErr as NodeJS.ErrnoException).code !== "ESRCH";
          }
        }

        if (Date.now() - lockTime > LOCK_STALE_MS && !pidAlive) {
          // Lock is stale AND holder is dead — safe to force-unlock
          try { await fs.unlink(lock); } catch { /* race */ }
          continue;
        }
      } catch { /* lock disappeared — retry */ }

      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }

  // Last resort: only force-unlock if holder is dead
  const lastResortContent = await fs.readFile(lock, "utf-8").catch(() => "");
  let lastResortPid: number | undefined;
  try {
    lastResortPid = JSON.parse(lastResortContent).pid;
  } catch { /* legacy format, no PID */ }

  let lastResortPidAlive = false;
  if (lastResortPid) {
    try {
      process.kill(lastResortPid, 0);
      lastResortPidAlive = true;
    } catch (killErr: unknown) {
      // ESRCH: process does not exist — truly dead
      // EPERM: process exists but different UID — treat as alive (conservative)
      // Same logic as in the retry loop above to ensure consistent PID liveness detection
      lastResortPidAlive = (killErr as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  if (!lastResortPidAlive) {
    try { await fs.unlink(lock); } catch { /* ignore */ }
    try {
      await fs.writeFile(lock, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), { flag: "wx" });
    } catch (writeErr: unknown) {
      throw new Error(`Failed to acquire lock at ${lock} after timeout: ${String(writeErr)}`);
    }
  } else {
    throw new Error(`Lock held by live PID ${lastResortPid} for >${LOCK_TIMEOUT_MS}ms — refusing to force-unlock`);
  }
}

export async function releaseLock(workspaceDir: string): Promise<void> {
  try { await fs.unlink(lockPath(workspaceDir)); } catch { /* already removed */ }
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

function projectsPath(workspaceDir: string): string {
  return path.join(workspaceDir, DATA_DIR, "projects.json");
}

export async function readProjects(workspaceDir: string): Promise<ProjectsData> {
  await ensureWorkspaceMigrated(workspaceDir);
  const raw = await readJsonWithFallback(projectsPath(workspaceDir));
  let data = JSON.parse(raw) as any;

  // Auto-migrate legacy schema to new schema
  if (isLegacySchema(data)) {
    data = await migrateLegacySchema(data);
    // Write migrated schema back to disk
    await writeProjects(workspaceDir, data as ProjectsData);
  }

  const typedData = data as ProjectsData;

  // Apply per-project migrations and persist if any changed
  let migrated = false;
  for (const project of Object.values(typedData.projects)) {
    if (migrateProject(project as any)) migrated = true;
  }
  if (migrated) {
    await writeProjects(workspaceDir, typedData);
  }

  return typedData;
}

export async function writeProjects(
  workspaceDir: string,
  data: ProjectsData,
): Promise<void> {
  const filePath = projectsPath(workspaceDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await backupFile(filePath);
  await writeSafe(filePath, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Resolve a project by slug or channelId (for backward compatibility).
 * Returns the slug of the found project.
 */
export function resolveProjectSlug(
  data: ProjectsData,
  slugOrChannelId: string,
  messageThreadId?: number | null,
): string | undefined {
  // Direct lookup by slug
  if (data.projects[slugOrChannelId]) {
    return slugOrChannelId;
  }

  if (messageThreadId !== null && messageThreadId !== undefined) {
    const resolved = findProjectByRoute(data, {
      channel: "telegram",
      channelId: slugOrChannelId,
      messageThreadId,
    });
    if (resolved) {
      return resolved.slug;
    }
  }
  const projectsOnChannel = findProjectsByChannelId(data, slugOrChannelId);
  if (projectsOnChannel.some(({ project }) => isForumProject(project, slugOrChannelId))) {
    return undefined;
  }

  return findProjectByChannelId(data, slugOrChannelId)?.slug;
}

/**
 * Get a project by slug or channelId (dual-mode resolution).
 */
export function getProject(
  data: ProjectsData,
  slugOrChannelId: string,
  messageThreadId?: number | null,
): Project | undefined {
  const slug = resolveProjectSlug(data, slugOrChannelId, messageThreadId);
  return slug ? data.projects[slug] : undefined;
}

export function getProjectByRoute(
  data: ProjectsData,
  route: RouteRef,
): Project | undefined {
  return findProjectByRoute(data, route)?.project;
}

/**
 * Read projects.json and return a single project by slug.
 * Convenience wrapper around readProjects + getProject.
 */
export async function loadProjectBySlug(
  workspaceDir: string,
  slug: string,
): Promise<Project | undefined> {
  const data = await readProjects(workspaceDir);
  return getProject(data, slug);
}

/**
 * Transactional mutation wrapper.
 * acquire lock → read → apply fn → verify seq → write → release
 * Retries on seq mismatch (optimistic locking) up to 3 times.
 */
export async function withProjectsMutation<T>(
  workspaceDir: string,
  fn: (data: ProjectsData) => T,
): Promise<{ data: ProjectsData; result: T }> {
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [100, 200, 400];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await acquireLock(workspaceDir);
    try {
      const data = await readProjects(workspaceDir);
      const seqBefore = (data as any)._seq ?? 0;

      const result = fn(data);

      // Re-read to check for concurrent write (optimistic locking)
      let currentSeq: number;
      try {
        const currentRaw = await fs.readFile(projectsPath(workspaceDir), "utf-8");
        currentSeq = (JSON.parse(currentRaw) as any)._seq ?? 0;
      } catch {
        currentSeq = seqBefore; // file gone — treat as match
      }

      if (currentSeq !== seqBefore && attempt < MAX_RETRIES) {
        // Seq mismatch — releaseLock is in finally, then retry with backoff
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt] ?? 400));
        continue;
      }

      // Increment seq and write
      (data as any)._seq = seqBefore + 1;
      await writeProjects(workspaceDir, data);
      return { data, result };
    } finally {
      await releaseLock(workspaceDir);
    }
  }

  throw new Error(`withProjectsMutation: seq mismatch after ${MAX_RETRIES} retries`);
}

/**
 * Resolve repo path from projects.json repo field (handles ~/ expansion).
 */
export function resolveRepoPath(repoField: string): string {
  if (repoField.startsWith("~/")) {
    return repoField.replace("~", homedir());
  }
  return repoField;
}
