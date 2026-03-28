import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../setup/constants.js";
import { ensureWorkspaceMigrated } from "../setup/migrate-layout.js";
import type {
  FabricaRunStore,
  GitHubEventUpdate,
  GitHubEventListFilters,
  GitHubEventStore,
  SaveReceivedResult,
} from "./event-store.js";
import {
  fabricaRunSchema,
  githubEventRecordSchema,
  type FabricaRun,
  type GitHubEventRecord,
  type GitHubEventStatus,
} from "./types.js";

type DatabaseSyncLike = {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes?: number; lastInsertRowid?: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Array<Record<string, unknown>>;
  };
};

type SqliteModule = {
  DatabaseSync: new (filename: string) => DatabaseSyncLike;
};

type SqliteStores = {
  eventStore: GitHubEventStore;
  runStore: FabricaRunStore;
};

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function parseEventRow(row: Record<string, unknown>): GitHubEventRecord {
  return githubEventRecordSchema.parse({
    deliveryId: asString(row.delivery_id) ?? "",
    eventName: asString(row.event_name) ?? "",
    action: asNullableString(row.action),
    installationId: asNumber(row.installation_id),
    repositoryId: asNumber(row.repository_id),
    prNumber: asNumber(row.pr_number),
    headSha: asNullableString(row.head_sha),
    receivedAt: asString(row.received_at) ?? "",
    processedAt: asNullableString(row.processed_at),
    status: row.status,
    attemptCount: asNumber(row.attempt_count) ?? 0,
    nextAttemptAt: asNullableString(row.next_attempt_at),
    lastErrorAt: asNullableString(row.last_error_at),
    deadLetter: Boolean(row.dead_letter),
    runId: asNullableString(row.run_id),
    issueRuntimeId: asNullableString(row.issue_runtime_id),
    checkRunId: asNumber(row.check_run_id),
    sessionKey: asNullableString(row.session_key),
    payload: JSON.parse(asString(row.payload_json) ?? "null"),
    error: asNullableString(row.error),
  });
}

function parseRunRow(row: Record<string, unknown>): FabricaRun {
  return fabricaRunSchema.parse({
    runId: asString(row.run_id) ?? "",
    installationId: asNumber(row.installation_id) ?? 0,
    repositoryId: asNumber(row.repository_id) ?? 0,
    prNumber: asNumber(row.pr_number) ?? 0,
    headSha: asString(row.head_sha) ?? "",
    issueRuntimeId: asNullableString(row.issue_runtime_id),
    state: row.state,
    checkRunId: asNumber(row.check_run_id),
    createdAt: asString(row.created_at) ?? "",
    updatedAt: asString(row.updated_at) ?? "",
  });
}

async function loadSqliteModule(): Promise<SqliteModule> {
  const loaded = await import("node:sqlite");
  if (!loaded?.DatabaseSync) {
    throw new Error("node:sqlite DatabaseSync is unavailable");
  }
  return loaded as unknown as SqliteModule;
}

async function openDatabase(dbPath: string): Promise<DatabaseSyncLike> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = await loadSqliteModule();
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS github_events (
      delivery_id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      action TEXT,
      installation_id INTEGER,
      repository_id INTEGER,
      pr_number INTEGER,
      head_sha TEXT,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error_at TEXT,
      dead_letter INTEGER NOT NULL DEFAULT 0,
      run_id TEXT,
      issue_runtime_id TEXT,
      check_run_id INTEGER,
      session_key TEXT,
      payload_json TEXT NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS github_events_status_received_at_idx
      ON github_events (status, received_at);
    CREATE INDEX IF NOT EXISTS github_events_pr_idx
      ON github_events (installation_id, repository_id, pr_number, received_at);

    CREATE TABLE IF NOT EXISTS fabrica_runs (
      run_id TEXT PRIMARY KEY,
      installation_id INTEGER NOT NULL,
      repository_id INTEGER NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      issue_runtime_id TEXT,
      state TEXT NOT NULL,
      check_run_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fabrica_runs_pr_idx
      ON fabrica_runs (installation_id, repository_id, pr_number, head_sha, updated_at);
  `);
  const columns = db.prepare(`PRAGMA table_info(github_events)`).all();
  const existingColumns = new Set(columns.map((row) => String(row.name)));
  const requiredColumns = [
    ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
    ["next_attempt_at", "TEXT"],
    ["last_error_at", "TEXT"],
    ["dead_letter", "INTEGER NOT NULL DEFAULT 0"],
    ["run_id", "TEXT"],
    ["issue_runtime_id", "TEXT"],
    ["check_run_id", "INTEGER"],
    ["session_key", "TEXT"],
  ] as const;
  for (const [name, type] of requiredColumns) {
    if (!existingColumns.has(name)) {
      db.exec(`ALTER TABLE github_events ADD COLUMN ${name} ${type};`);
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS github_events_ready_idx
      ON github_events (dead_letter, status, next_attempt_at, received_at);
  `);
  return db;
}

export async function defaultGitHubSqlitePath(workspaceDir: string): Promise<string> {
  await ensureWorkspaceMigrated(workspaceDir);
  return path.join(workspaceDir, DATA_DIR, "github", "events.sqlite");
}

class SqliteGitHubEventStore implements GitHubEventStore {
  constructor(private readonly dbPromise: Promise<DatabaseSyncLike>) {}

  private async db(): Promise<DatabaseSyncLike> {
    return this.dbPromise;
  }

  async saveReceived(record: GitHubEventRecord): Promise<SaveReceivedResult> {
    const validated = githubEventRecordSchema.parse(record);
    const db = await this.db();

    try {
      db.prepare(`
        INSERT INTO github_events (
          delivery_id, event_name, action, installation_id, repository_id, pr_number,
          head_sha, received_at, processed_at, status, attempt_count, next_attempt_at,
          last_error_at, dead_letter, run_id, issue_runtime_id, check_run_id, session_key,
          payload_json, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        validated.deliveryId,
        validated.eventName,
        validated.action ?? null,
        validated.installationId ?? null,
        validated.repositoryId ?? null,
        validated.prNumber ?? null,
        validated.headSha ?? null,
        validated.receivedAt,
        validated.processedAt ?? null,
        validated.status,
        validated.attemptCount,
        validated.nextAttemptAt ?? null,
        validated.lastErrorAt ?? null,
        validated.deadLetter ? 1 : 0,
        validated.runId ?? null,
        validated.issueRuntimeId ?? null,
        validated.checkRunId ?? null,
        validated.sessionKey ?? null,
        JSON.stringify(validated.payload),
        validated.error ?? null,
      );
      return { duplicate: false, record: validated };
    } catch (error: any) {
      if (String(error?.message ?? "").includes("UNIQUE")) {
        const existing = await this.get(validated.deliveryId);
        return {
          duplicate: true,
          record: existing ?? validated,
        };
      }
      throw error;
    }
  }

  async get(deliveryId: string): Promise<GitHubEventRecord | null> {
    const db = await this.db();
    const row = db.prepare(`
      SELECT delivery_id, event_name, action, installation_id, repository_id, pr_number,
             head_sha, received_at, processed_at, status, attempt_count, next_attempt_at,
             last_error_at, dead_letter, run_id, issue_runtime_id, check_run_id, session_key,
             payload_json, error
      FROM github_events
      WHERE delivery_id = ?
    `).get(deliveryId);
    return row ? parseEventRow(row) : null;
  }

  async listByStatus(statuses: GitHubEventStatus[]): Promise<GitHubEventRecord[]> {
    if (statuses.length === 0) return [];
    const db = await this.db();
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT delivery_id, event_name, action, installation_id, repository_id, pr_number,
             head_sha, received_at, processed_at, status, attempt_count, next_attempt_at,
             last_error_at, dead_letter, run_id, issue_runtime_id, check_run_id, session_key,
             payload_json, error
      FROM github_events
      WHERE status IN (${placeholders})
      ORDER BY received_at ASC
    `).all(...statuses);
    return rows.map(parseEventRow);
  }

  async listEvents(filters?: GitHubEventListFilters): Promise<GitHubEventRecord[]> {
    const db = await this.db();
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    if (filters?.eventName) {
      clauses.push("event_name = ?");
      params.push(filters.eventName);
    }
    if (typeof filters?.prNumber === "number") {
      clauses.push("pr_number = ?");
      params.push(filters.prNumber);
    }
    if (typeof filters?.deadLetter === "boolean") {
      clauses.push("dead_letter = ?");
      params.push(filters.deadLetter ? 1 : 0);
    }

    let sql = `
      SELECT delivery_id, event_name, action, installation_id, repository_id, pr_number,
             head_sha, received_at, processed_at, status, attempt_count, next_attempt_at,
             last_error_at, dead_letter, run_id, issue_runtime_id, check_run_id, session_key,
             payload_json, error
      FROM github_events
    `;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY received_at DESC";
    if (typeof filters?.limit === "number" && Number.isFinite(filters.limit)) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }

    return db.prepare(sql).all(...params).map(parseEventRow);
  }

  async claimReady(limit = 20, now = new Date().toISOString()): Promise<GitHubEventRecord[]> {
    const db = await this.db();
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = db.prepare(`
        SELECT delivery_id
        FROM github_events
        WHERE dead_letter = 0
          AND status IN ('pending', 'failed')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY received_at ASC
        LIMIT ?
      `).all(now, limit);
      const ids = rows
        .map((row) => asString(row.delivery_id))
        .filter((value): value is string => Boolean(value));
      if (ids.length === 0) {
        db.exec("COMMIT");
        return [];
      }
      const placeholders = ids.map(() => "?").join(", ");
      db.prepare(`
        UPDATE github_events
        SET status = 'processing',
            attempt_count = attempt_count + 1,
            processed_at = NULL
        WHERE delivery_id IN (${placeholders})
      `).run(...ids);
      const claimedRows = db.prepare(`
        SELECT delivery_id, event_name, action, installation_id, repository_id, pr_number,
               head_sha, received_at, processed_at, status, attempt_count, next_attempt_at,
               last_error_at, dead_letter, run_id, issue_runtime_id, check_run_id, session_key,
               payload_json, error
        FROM github_events
        WHERE delivery_id IN (${placeholders})
      `).all(...ids);
      db.exec("COMMIT");
      return claimedRows
        .map(parseEventRow)
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async update(
    deliveryId: string,
    update: GitHubEventUpdate,
  ): Promise<GitHubEventRecord | null> {
    const db = await this.db();
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
    db.prepare(`
      UPDATE github_events
      SET status = ?,
          error = ?,
          processed_at = ?,
          attempt_count = ?,
          next_attempt_at = ?,
          last_error_at = ?,
          dead_letter = ?,
          run_id = ?,
          issue_runtime_id = ?,
          check_run_id = ?,
          session_key = ?
      WHERE delivery_id = ?
    `).run(
      next.status,
      next.error ?? null,
      next.processedAt ?? null,
      next.attemptCount,
      next.nextAttemptAt ?? null,
      next.lastErrorAt ?? null,
      next.deadLetter ? 1 : 0,
      next.runId ?? null,
      next.issueRuntimeId ?? null,
      next.checkRunId ?? null,
      next.sessionKey ?? null,
      deliveryId,
    );
    return this.get(deliveryId);
  }
}

class SqliteFabricaRunStore implements FabricaRunStore {
  constructor(private readonly dbPromise: Promise<DatabaseSyncLike>) {}

  private async db(): Promise<DatabaseSyncLike> {
    return this.dbPromise;
  }

  async save(run: FabricaRun): Promise<void> {
    const validated = fabricaRunSchema.parse(run);
    const db = await this.db();
    db.prepare(`
      DELETE FROM fabrica_runs
      WHERE installation_id = ? AND repository_id = ? AND pr_number = ? AND run_id <> ?
    `).run(
      validated.installationId,
      validated.repositoryId,
      validated.prNumber,
      validated.runId,
    );
    db.prepare(`
      INSERT INTO fabrica_runs (
        run_id, installation_id, repository_id, pr_number, head_sha,
        issue_runtime_id, state, check_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        installation_id = excluded.installation_id,
        repository_id = excluded.repository_id,
        pr_number = excluded.pr_number,
        head_sha = excluded.head_sha,
        issue_runtime_id = excluded.issue_runtime_id,
        state = excluded.state,
        check_run_id = excluded.check_run_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      validated.runId,
      validated.installationId,
      validated.repositoryId,
      validated.prNumber,
      validated.headSha,
      validated.issueRuntimeId ?? null,
      validated.state,
      validated.checkRunId ?? null,
      validated.createdAt,
      validated.updatedAt,
    );
  }

  async get(runId: string): Promise<FabricaRun | null> {
    const db = await this.db();
    const row = db.prepare(`
      SELECT run_id, installation_id, repository_id, pr_number, head_sha,
             issue_runtime_id, state, check_run_id, created_at, updated_at
      FROM fabrica_runs
      WHERE run_id = ?
    `).get(runId);
    return row ? parseRunRow(row) : null;
  }

  async findByPr(
    installationId: number,
    repositoryId: number,
    prNumber: number,
    headSha?: string,
  ): Promise<FabricaRun[]> {
    const db = await this.db();
    const rows = headSha
      ? db.prepare(`
          SELECT run_id, installation_id, repository_id, pr_number, head_sha,
                 issue_runtime_id, state, check_run_id, created_at, updated_at
          FROM fabrica_runs
          WHERE installation_id = ? AND repository_id = ? AND pr_number = ? AND head_sha = ?
          ORDER BY updated_at ASC
        `).all(installationId, repositoryId, prNumber, headSha)
      : db.prepare(`
          SELECT run_id, installation_id, repository_id, pr_number, head_sha,
                 issue_runtime_id, state, check_run_id, created_at, updated_at
          FROM fabrica_runs
          WHERE installation_id = ? AND repository_id = ? AND pr_number = ?
          ORDER BY updated_at ASC
        `).all(installationId, repositoryId, prNumber);
    return rows.map(parseRunRow);
  }
}

export async function createSqliteGitHubStores(dbPath: string): Promise<SqliteStores> {
  const dbPromise = openDatabase(dbPath);
  await dbPromise;
  return {
    eventStore: new SqliteGitHubEventStore(dbPromise),
    runStore: new SqliteFabricaRunStore(dbPromise),
  };
}
