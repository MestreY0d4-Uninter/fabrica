import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, ensureWorkspaceMigrated } from "../setup/migrate-layout.js";
import {
  type FabricaRunStore,
  type GitHubEventUpdate,
  type GitHubEventListFilters,
  type GitHubEventStore,
  type SaveReceivedResult,
} from "./event-store.js";
import {
  fabricaRunSchema,
  githubEventRecordSchema,
  type FabricaRun,
  type GitHubEventRecord,
  type GitHubEventStatus,
} from "./types.js";

function encodeId(id: string): string {
  return Buffer.from(id, "utf-8").toString("base64url");
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  await fs.rename(tmpPath, filePath);
}

async function writeNewJsonExclusive(filePath: string, value: unknown): Promise<boolean> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf-8",
      flag: "wx",
    });
    return true;
  } catch (error: any) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function defaultGitHubEventStorePath(workspaceDir: string): Promise<string> {
  await ensureWorkspaceMigrated(workspaceDir);
  return path.join(workspaceDir, DATA_DIR, "github", "events");
}

export async function defaultFabricaRunStorePath(workspaceDir: string): Promise<string> {
  await ensureWorkspaceMigrated(workspaceDir);
  return path.join(workspaceDir, DATA_DIR, "github", "runs");
}

export class FileGitHubEventStore implements GitHubEventStore {
  constructor(private readonly storeDir: string) {}

  private async eventPath(deliveryId: string): Promise<string> {
    return path.join(this.storeDir, `${encodeId(deliveryId)}.json`);
  }

  async saveReceived(record: GitHubEventRecord): Promise<SaveReceivedResult> {
    const validated = githubEventRecordSchema.parse(record);
    const filePath = await this.eventPath(validated.deliveryId);
    const existing = await readJsonFile<GitHubEventRecord>(filePath);
    if (existing) {
      return {
        duplicate: true,
        record: githubEventRecordSchema.parse(existing),
      };
    }
    const created = await writeNewJsonExclusive(filePath, validated);
    if (!created) {
      const duplicate = await readJsonFile<GitHubEventRecord>(filePath);
      return {
        duplicate: true,
        record: githubEventRecordSchema.parse(duplicate ?? validated),
      };
    }
    return { duplicate: false, record: validated };
  }

  async get(deliveryId: string): Promise<GitHubEventRecord | null> {
    const filePath = await this.eventPath(deliveryId);
    const record = await readJsonFile<GitHubEventRecord>(filePath);
    return record ? githubEventRecordSchema.parse(record) : null;
  }

  async listByStatus(status: GitHubEventStatus[]): Promise<GitHubEventRecord[]> {
    const wanted = new Set(status);
    const dir = this.storeDir;
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }

    const records: GitHubEventRecord[] = [];
    for (const entry of entries) {
      const record = await readJsonFile<GitHubEventRecord>(path.join(dir, entry));
      if (!record) continue;
      const parsed = githubEventRecordSchema.parse(record);
      if (wanted.has(parsed.status)) records.push(parsed);
    }

    return records.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  async listEvents(filters?: GitHubEventListFilters): Promise<GitHubEventRecord[]> {
    const dir = this.storeDir;
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }

    const records: GitHubEventRecord[] = [];
    for (const entry of entries) {
      const record = await readJsonFile<GitHubEventRecord>(path.join(dir, entry));
      if (!record) continue;
      const parsed = githubEventRecordSchema.parse(record);
      if (filters?.status && parsed.status !== filters.status) continue;
      if (filters?.eventName && parsed.eventName !== filters.eventName) continue;
      if (typeof filters?.prNumber === "number" && parsed.prNumber !== filters.prNumber) continue;
      if (typeof filters?.deadLetter === "boolean" && parsed.deadLetter !== filters.deadLetter) continue;
      records.push(parsed);
    }

    const sorted = records.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    const limit = filters?.limit;
    return typeof limit === "number" && Number.isFinite(limit) ? sorted.slice(0, limit) : sorted;
  }

  async claimReady(limit = 20, now = new Date().toISOString()): Promise<GitHubEventRecord[]> {
    const ready = (await this.listEvents())
      .reverse()
      .filter((record) => {
        if (record.deadLetter) return false;
        if (record.status !== "pending" && record.status !== "failed") return false;
        return !record.nextAttemptAt || record.nextAttemptAt <= now;
      })
      .slice(0, limit);

    const claimed: GitHubEventRecord[] = [];
    for (const record of ready) {
      const next = githubEventRecordSchema.parse({
        ...record,
        status: "processing",
        attemptCount: record.attemptCount + 1,
        processedAt: null,
      });
      await atomicWriteJson(await this.eventPath(record.deliveryId), next);
      claimed.push(next);
    }
    return claimed;
  }

  async update(
    deliveryId: string,
    update: GitHubEventUpdate,
  ): Promise<GitHubEventRecord | null> {
    const existing = await this.get(deliveryId);
    if (!existing) return null;
    const next = githubEventRecordSchema.parse({
      ...existing,
      status: update.status ?? existing.status,
      error: update.error === undefined ? existing.error : update.error,
      processedAt: update.processedAt === undefined ? existing.processedAt : update.processedAt,
      attemptCount: update.attemptCount ?? existing.attemptCount,
      nextAttemptAt: update.nextAttemptAt === undefined ? existing.nextAttemptAt : update.nextAttemptAt,
      lastErrorAt: update.lastErrorAt === undefined ? existing.lastErrorAt : update.lastErrorAt,
      deadLetter: update.deadLetter ?? existing.deadLetter,
      runId: update.runId === undefined ? existing.runId : update.runId,
      issueRuntimeId: update.issueRuntimeId === undefined ? existing.issueRuntimeId : update.issueRuntimeId,
      checkRunId: update.checkRunId === undefined ? existing.checkRunId : update.checkRunId,
      sessionKey: update.sessionKey === undefined ? existing.sessionKey : update.sessionKey,
    });
    await atomicWriteJson(await this.eventPath(deliveryId), next);
    return next;
  }
}

export class FileFabricaRunStore implements FabricaRunStore {
  constructor(private readonly storeDir: string) {}

  private async runPath(runId: string): Promise<string> {
    return path.join(this.storeDir, `${encodeId(runId)}.json`);
  }

  async save(run: FabricaRun): Promise<void> {
    const validated = fabricaRunSchema.parse(run);
    try {
      const entries = await fs.readdir(this.storeDir);
      for (const entry of entries) {
        const filePath = path.join(this.storeDir, entry);
        const existing = await readJsonFile<FabricaRun>(filePath);
        if (!existing) continue;
        const parsed = fabricaRunSchema.parse(existing);
        if (
          parsed.runId !== validated.runId &&
          parsed.installationId === validated.installationId &&
          parsed.repositoryId === validated.repositoryId &&
          parsed.prNumber === validated.prNumber
        ) {
          await fs.rm(filePath, { force: true });
        }
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    await atomicWriteJson(await this.runPath(validated.runId), validated);
  }

  async get(runId: string): Promise<FabricaRun | null> {
    const run = await readJsonFile<FabricaRun>(await this.runPath(runId));
    return run ? fabricaRunSchema.parse(run) : null;
  }

  async findByPr(
    installationId: number,
    repositoryId: number,
    prNumber: number,
    headSha?: string,
  ): Promise<FabricaRun[]> {
    const dir = this.storeDir;
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }

    const runs: FabricaRun[] = [];
    for (const entry of entries) {
      const run = await readJsonFile<FabricaRun>(path.join(dir, entry));
      if (!run) continue;
      const parsed = fabricaRunSchema.parse(run);
      if (
        parsed.installationId === installationId &&
        parsed.repositoryId === repositoryId &&
        parsed.prNumber === prNumber &&
        (!headSha || parsed.headSha === headSha)
      ) {
        runs.push(parsed);
      }
    }

    return runs.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }
}
