import { githubEventRecordSchema, type FabricaRun, type GitHubEventRecord, type GitHubEventStatus } from "./types.js";

export type SaveReceivedResult = {
  duplicate: boolean;
  record: GitHubEventRecord;
};

export type GitHubEventListFilters = {
  status?: GitHubEventStatus;
  eventName?: string;
  prNumber?: number;
  deadLetter?: boolean;
  limit?: number;
};

export type GitHubEventUpdate = {
  status?: GitHubEventStatus;
  error?: string | null;
  processedAt?: string | null;
  attemptCount?: number;
  nextAttemptAt?: string | null;
  lastErrorAt?: string | null;
  deadLetter?: boolean;
  runId?: string | null;
  issueRuntimeId?: string | null;
  checkRunId?: number | null;
  sessionKey?: string | null;
};

export interface GitHubEventStore {
  saveReceived(record: GitHubEventRecord): Promise<SaveReceivedResult>;
  get(deliveryId: string): Promise<GitHubEventRecord | null>;
  listByStatus(status: GitHubEventStatus[]): Promise<GitHubEventRecord[]>;
  listEvents(filters?: GitHubEventListFilters): Promise<GitHubEventRecord[]>;
  claimReady(limit?: number, now?: string): Promise<GitHubEventRecord[]>;
  update(deliveryId: string, update: GitHubEventUpdate): Promise<GitHubEventRecord | null>;
}

export interface FabricaRunStore {
  save(run: FabricaRun): Promise<void>;
  get(runId: string): Promise<FabricaRun | null>;
  findByPr(
    installationId: number,
    repositoryId: number,
    prNumber: number,
    headSha?: string,
  ): Promise<FabricaRun[]>;
}

export class InMemoryGitHubEventStore implements GitHubEventStore {
  private readonly records = new Map<string, GitHubEventRecord>();

  async saveReceived(record: GitHubEventRecord): Promise<SaveReceivedResult> {
    const validated = githubEventRecordSchema.parse(record);
    const existing = this.records.get(validated.deliveryId);
    if (existing) return { duplicate: true, record: existing };
    this.records.set(validated.deliveryId, validated);
    return { duplicate: false, record: validated };
  }

  async get(deliveryId: string): Promise<GitHubEventRecord | null> {
    return this.records.get(deliveryId) ?? null;
  }

  async listByStatus(status: GitHubEventStatus[]): Promise<GitHubEventRecord[]> {
    const wanted = new Set(status);
    return Array.from(this.records.values()).filter((record) => wanted.has(record.status));
  }

  async listEvents(filters?: GitHubEventListFilters): Promise<GitHubEventRecord[]> {
    const records = Array.from(this.records.values()).filter((record) => {
      if (filters?.status && record.status !== filters.status) return false;
      if (filters?.eventName && record.eventName !== filters.eventName) return false;
      if (typeof filters?.prNumber === "number" && record.prNumber !== filters.prNumber) return false;
      if (typeof filters?.deadLetter === "boolean" && record.deadLetter !== filters.deadLetter) return false;
      return true;
    }).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));

    const limit = filters?.limit;
    return typeof limit === "number" && Number.isFinite(limit) ? records.slice(0, limit) : records;
  }

  async claimReady(limit = 20, now = new Date().toISOString()): Promise<GitHubEventRecord[]> {
    const ready = Array.from(this.records.values())
      .filter((record) => {
        if (record.deadLetter) return false;
        if (record.status !== "pending" && record.status !== "failed") return false;
        return !record.nextAttemptAt || record.nextAttemptAt <= now;
      })
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
      .slice(0, limit);

    const claimed: GitHubEventRecord[] = [];
    for (const record of ready) {
      const next: GitHubEventRecord = {
        ...record,
        status: "processing",
        attemptCount: record.attemptCount + 1,
        processedAt: null,
      };
      this.records.set(record.deliveryId, next);
      claimed.push(next);
    }
    return claimed;
  }

  async update(
    deliveryId: string,
    update: GitHubEventUpdate,
  ): Promise<GitHubEventRecord | null> {
    const existing = this.records.get(deliveryId);
    if (!existing) return null;
    const next: GitHubEventRecord = {
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
    };
    this.records.set(deliveryId, next);
    return next;
  }
}

export class InMemoryFabricaRunStore implements FabricaRunStore {
  private readonly runs = new Map<string, FabricaRun>();

  async save(run: FabricaRun): Promise<void> {
    for (const [key, existing] of this.runs.entries()) {
      if (
        key !== run.runId &&
        existing.installationId === run.installationId &&
        existing.repositoryId === run.repositoryId &&
        existing.prNumber === run.prNumber
      ) {
        this.runs.delete(key);
      }
    }
    this.runs.set(run.runId, run);
  }

  async get(runId: string): Promise<FabricaRun | null> {
    return this.runs.get(runId) ?? null;
  }

  async findByPr(
    installationId: number,
    repositoryId: number,
    prNumber: number,
    headSha?: string,
  ): Promise<FabricaRun[]> {
    return Array.from(this.runs.values()).filter((run) =>
      run.installationId === installationId &&
      run.repositoryId === repositoryId &&
      run.prNumber === prNumber &&
      (!headSha || run.headSha === headSha),
    );
  }
}
