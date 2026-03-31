/**
 * projects/mutations.ts — State mutations for project worker slots.
 */
import type { SlotState, RoleWorkerState, Project, ProjectsData, IssueRuntimeState } from "./types.js";
import { resolveProjectSlug, withProjectsMutation } from "./io.js";
import { emptySlot, findFreeSlot, findSlotByIssue } from "./slots.js";

/**
 * Get the RoleWorkerState for a given role.
 * Returns an empty state if the role has no workers configured.
 */
export function getRoleWorker(
  project: Project,
  role: string,
): RoleWorkerState {
  return project.workers[role] ?? { levels: {} };
}

export function getIssueRuntime(
  project: Project,
  issueId: number | string,
): IssueRuntimeState | undefined {
  return project.issueRuntime?.[String(issueId)];
}

/**
 * Update a specific slot in a role's worker state.
 * Uses withProjectsMutation for transactional locking with optimistic seq check.
 */
export async function updateSlot(
  workspaceDir: string,
  slugOrChannelId: string,
  role: string,
  level: string,
  slotIndex: number,
  updates: Partial<SlotState>,
): Promise<ProjectsData> {
  const { data } = await withProjectsMutation(workspaceDir, (data) => {
    const slug = resolveProjectSlug(data, slugOrChannelId);
    if (!slug) {
      throw new Error(`Project not found for slug or channelId: ${slugOrChannelId}`);
    }

    const project = data.projects[slug]!;
    const rw = project.workers[role] ?? { levels: {} };
    if (!rw.levels[level]) rw.levels[level] = [];
    const slots = rw.levels[level]!;

    // Ensure slot exists
    while (slots.length <= slotIndex) {
      slots.push(emptySlot());
    }

    slots[slotIndex] = { ...slots[slotIndex]!, ...updates };
    project.workers[role] = rw;
  });
  return data;
}

/**
 * Mark a worker slot as active with a new task.
 * Routes by level to the correct slot array.
 * Accepts slug or channelId (dual-mode).
 */
export async function activateWorker(
  workspaceDir: string,
  slugOrChannelId: string,
  role: string,
  params: {
    issueId: string;
    level: string;
    sessionKey?: string;
    startTime?: string;
    dispatchCycleId?: string | null;
    dispatchRunId?: string | null;
    /** Label the issue had before transitioning to the active state (e.g. "To Do", "To Improve"). */
    previousLabel?: string;
    /** Slot index within the level's array. If omitted, finds first free slot. */
    slotIndex?: number;
    /** Deterministic fun name for this slot. */
    name?: string;
  },
): Promise<ProjectsData> {
  const { data } = await withProjectsMutation(workspaceDir, (data) => {
    const slug = resolveProjectSlug(data, slugOrChannelId);
    if (!slug) {
      throw new Error(`Project not found for slug or channelId: ${slugOrChannelId}`);
    }

    const project = data.projects[slug]!;
    const rw = project.workers[role] ?? { levels: {} };
    if (!rw.levels[params.level]) rw.levels[params.level] = [];
    const slots = rw.levels[params.level]!;

    const idx = params.slotIndex ?? findFreeSlot(rw, params.level) ?? 0;

    // Ensure slot exists
    while (slots.length <= idx) {
      slots.push(emptySlot());
    }

    slots[idx] = {
      active: true,
      issueId: params.issueId,
      sessionKey: params.sessionKey ?? slots[idx]!.sessionKey,
      startTime: params.startTime ?? new Date().toISOString(),
      dispatchCycleId: params.dispatchCycleId ?? null,
      dispatchRunId: params.dispatchRunId ?? null,
      previousLabel: params.previousLabel ?? null,
      name: params.name ?? slots[idx]!.name,
      lastIssueId: null,
    };

    project.workers[role] = rw;
  });
  return data;
}

/**
 * Mark a worker slot as inactive after task completion.
 * Preserves sessionKey for session reuse.
 * Finds the slot by issueId (searches across all levels), or by explicit level+slotIndex.
 * Accepts slug or channelId (dual-mode).
 */
export async function deactivateWorker(
  workspaceDir: string,
  slugOrChannelId: string,
  role: string,
  opts?: { level?: string; slotIndex?: number; issueId?: string },
): Promise<ProjectsData> {
  const { data } = await withProjectsMutation(workspaceDir, (data) => {
    const slug = resolveProjectSlug(data, slugOrChannelId);
    if (!slug) {
      throw new Error(`Project not found for slug or channelId: ${slugOrChannelId}`);
    }

    const project = data.projects[slug]!;
    const rw = project.workers[role] ?? { levels: {} };

    let level: string | undefined;
    let idx: number | undefined;

    if (opts?.level !== undefined && opts?.slotIndex !== undefined) {
      level = opts.level;
      idx = opts.slotIndex;
    } else if (opts?.issueId) {
      const found = findSlotByIssue(rw, opts.issueId);
      if (found) {
        level = found.level;
        idx = found.slotIndex;
      }
    }

    if (level !== undefined && idx !== undefined) {
      const slots = rw.levels[level];
      if (slots && idx < slots.length) {
        const slot = slots[idx]!;
        slots[idx] = {
          active: false,
          issueId: null,
          sessionKey: slot.sessionKey,
          startTime: null,
          dispatchCycleId: slot.dispatchCycleId ?? null,
          dispatchRunId: slot.dispatchRunId ?? null,
          previousLabel: null,
          name: slot.name,
          lastIssueId: slot.issueId,
        };
      }
    }

    project.workers[role] = rw;
  });
  return data;
}

export async function updateIssueRuntime(
  workspaceDir: string,
  slugOrChannelId: string,
  issueId: number | string,
  updates: Partial<IssueRuntimeState>,
): Promise<ProjectsData> {
  const { data } = await withProjectsMutation(workspaceDir, (data) => {
    const slug = resolveProjectSlug(data, slugOrChannelId);
    if (!slug) {
      throw new Error(`Project not found for slug or channelId: ${slugOrChannelId}`);
    }

    const project = data.projects[slug]!;
    project.issueRuntime ??= {};
    const key = String(issueId);
    project.issueRuntime[key] = {
      ...(project.issueRuntime[key] ?? {}),
      ...updates,
    };
  });
  return data;
}

export async function bindDispatchRunIdBySessionKey(
  workspaceDir: string,
  sessionKey: string,
  runId: string,
): Promise<{ slug: string; issueId: number; role: string; level: string; slotIndex: number } | null> {
  const { result } = await withProjectsMutation(workspaceDir, (data) => {
    for (const [slug, project] of Object.entries(data.projects)) {
      for (const [role, roleWorker] of Object.entries(project.workers ?? {})) {
        for (const [level, slots] of Object.entries(roleWorker.levels ?? {})) {
          for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
            const slot = slots[slotIndex]!;
            if (!slot.active || !slot.issueId || slot.sessionKey !== sessionKey) continue;

            slot.dispatchRunId = runId;
            project.issueRuntime ??= {};
            const issueKey = String(slot.issueId);
            project.issueRuntime[issueKey] = {
              ...(project.issueRuntime[issueKey] ?? {}),
              dispatchRunId: runId,
              lastSessionKey: sessionKey,
            };

            return {
              slug,
              issueId: Number(slot.issueId),
              role,
              level,
              slotIndex,
            };
          }
        }
      }
    }
    return null;
  });

  return result;
}

export async function clearIssueRuntime(
  workspaceDir: string,
  slugOrChannelId: string,
  issueId: number | string,
): Promise<ProjectsData> {
  const { data } = await withProjectsMutation(workspaceDir, (data) => {
    const slug = resolveProjectSlug(data, slugOrChannelId);
    if (!slug) {
      throw new Error(`Project not found for slug or channelId: ${slugOrChannelId}`);
    }

    const project = data.projects[slug]!;
    if (project.issueRuntime) {
      delete project.issueRuntime[String(issueId)];
    }
  });
  return data;
}
