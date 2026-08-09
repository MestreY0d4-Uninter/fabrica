import fs from "node:fs/promises";
import path from "node:path";

export type CoordinatorRunStatus = "queued" | "accepted" | "running" | "requeue" | "quarantined" | "done";
export type CoordinatorSessionState = "BOOTSTRAP_READY" | "RUNTIME_ACCEPTED" | "MISSING" | "DELETED";

export type CoordinatorRun = {
  runId: string;
  issueId: string;
  generation: number;
  status: CoordinatorRunStatus;
  leaseEpoch: number;
  sequence: number;
  createdAt: string;
  updatedAt: string;
};

export type CoordinatorLease = {
  runId: string;
  owner: string;
  generation: number;
  leaseEpoch: number;
  expiresAt: string;
};

export type CoordinatorEvent = {
  runId: string;
  generation: number;
  leaseEpoch: number;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type CoordinatorRecovery = {
  runId: string;
  issueId: string;
  generation: number;
  action: "requeue" | "quarantine";
  reason: string;
};

type Statement = {
  run(...params: unknown[]): { changes?: number; lastInsertRowid?: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
};

type Database = {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): Statement;
};

type Sqlite = { DatabaseSync: new (filename: string) => Database };

async function loadSqlite(): Promise<Sqlite> {
  const module = await import("node:sqlite");
  if (!module.DatabaseSync) throw new Error("node:sqlite DatabaseSync is unavailable");
  return module as unknown as Sqlite;
}

function now(): string { return new Date().toISOString(); }
function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function asString(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }

function readRun(row: Record<string, unknown>): CoordinatorRun {
  return {
    runId: asString(row.run_id), issueId: asString(row.issue_id), generation: asNumber(row.generation),
    status: asString(row.status) as CoordinatorRunStatus, leaseEpoch: asNumber(row.lease_epoch),
    sequence: asNumber(row.sequence), createdAt: asString(row.created_at), updatedAt: asString(row.updated_at),
  };
}

export class CoordinatorLedger {
  private constructor(private readonly db: Database) {}

  static async open(dbPath: string): Promise<CoordinatorLedger> {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const sqlite = await loadSqlite();
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_runs (
        run_id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        sequence INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS coordinator_issue_generation_idx
        ON coordinator_runs(issue_id, generation);
      CREATE TABLE IF NOT EXISTS coordinator_leases (
        run_id TEXT PRIMARY KEY REFERENCES coordinator_runs(run_id) ON DELETE CASCADE,
        owner TEXT NOT NULL,
        generation INTEGER NOT NULL,
        lease_epoch INTEGER NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coordinator_sessions (
        run_id TEXT NOT NULL REFERENCES coordinator_runs(run_id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        session_key TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id, generation, session_key)
      );
      CREATE TABLE IF NOT EXISTS coordinator_events (
        run_id TEXT NOT NULL REFERENCES coordinator_runs(run_id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        lease_epoch INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, generation, sequence)
      );
      CREATE TABLE IF NOT EXISTS coordinator_outbox (
        idempotency_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES coordinator_runs(run_id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        delivered_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coordinator_artifacts (
        run_id TEXT NOT NULL REFERENCES coordinator_runs(run_id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        kind TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, generation, kind)
      );
      CREATE TABLE IF NOT EXISTS coordinator_qa (
        run_id TEXT NOT NULL REFERENCES coordinator_runs(run_id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        gate TEXT NOT NULL,
        passed INTEGER NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, generation, gate)
      );
      CREATE TABLE IF NOT EXISTS coordinator_deploy (
        run_id TEXT NOT NULL REFERENCES coordinator_runs(run_id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        environment TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, generation, environment)
      );
      CREATE TABLE IF NOT EXISTS coordinator_quarantine (
        run_id TEXT NOT NULL REFERENCES coordinator_runs(run_id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, generation)
      );
    `);
    return new CoordinatorLedger(db);
  }

  close(): void { this.db.close(); }

  createRun(runId: string, issueId: string, createdAt = now()): CoordinatorRun {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare("SELECT MAX(generation) AS generation FROM coordinator_runs WHERE issue_id = ?").get(issueId);
      const generation = asNumber(previous?.generation, -1) + 1;
      this.db.prepare("UPDATE coordinator_runs SET status='requeue', updated_at=? WHERE issue_id=? AND status NOT IN ('done','quarantined')").run(createdAt, issueId);
      this.db.prepare("DELETE FROM coordinator_leases WHERE run_id IN (SELECT run_id FROM coordinator_runs WHERE issue_id=? AND generation<?)").run(issueId, generation);
      this.db.prepare(`INSERT INTO coordinator_runs(run_id, issue_id, generation, status, lease_epoch, sequence, created_at, updated_at)
        VALUES (?, ?, ?, 'queued', 0, 0, ?, ?)`).run(runId, issueId, generation, createdAt, createdAt);
      this.db.exec("COMMIT");
      return this.getRun(runId)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  getRun(runId: string): CoordinatorRun | null {
    const row = this.db.prepare("SELECT * FROM coordinator_runs WHERE run_id = ?").get(runId);
    return row ? readRun(row) : null;
  }

  acquireLease(runId: string, owner: string, ttlMs: number, expectedGeneration: number, expectedLeaseEpoch: number): CoordinatorLease | null {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.db.prepare("SELECT * FROM coordinator_runs WHERE run_id = ?").get(runId);
      if (!run || asNumber(run.generation) !== expectedGeneration || asNumber(run.lease_epoch) !== expectedLeaseEpoch || ["quarantined", "done"].includes(asString(run.status))) {
        this.db.exec("ROLLBACK"); return null;
      }
      const existing = this.db.prepare("SELECT * FROM coordinator_leases WHERE run_id = ?").get(runId);
      if (existing && asString(existing.expires_at) > now() && asString(existing.owner) !== owner) {
        this.db.exec("ROLLBACK"); return null;
      }
      const leaseEpoch = expectedLeaseEpoch + 1;
      this.db.prepare(`INSERT INTO coordinator_leases(run_id, owner, generation, lease_epoch, expires_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET owner=excluded.owner, generation=excluded.generation, lease_epoch=excluded.lease_epoch, expires_at=excluded.expires_at`)
        .run(runId, owner, expectedGeneration, leaseEpoch, expiresAt);
      this.db.prepare("UPDATE coordinator_runs SET lease_epoch = ?, status = 'accepted', updated_at = ? WHERE run_id = ? AND generation = ? AND lease_epoch = ?")
        .run(leaseEpoch, now(), runId, expectedGeneration, expectedLeaseEpoch);
      this.db.exec("COMMIT");
      return { runId, owner, generation: expectedGeneration, leaseEpoch, expiresAt };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  renewLease(lease: CoordinatorLease, ttlMs: number): boolean {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const result = this.db.prepare(`UPDATE coordinator_leases SET expires_at = ?
      WHERE run_id = ? AND owner = ? AND generation = ? AND lease_epoch = ? AND expires_at > ?`)
      .run(expiresAt, lease.runId, lease.owner, lease.generation, lease.leaseEpoch, now());
    return (result.changes ?? 0) === 1;
  }

  releaseLease(lease: CoordinatorLease): boolean {
    const result = this.db.prepare(`DELETE FROM coordinator_leases
      WHERE run_id = ? AND owner = ? AND generation = ? AND lease_epoch = ?`).run(lease.runId, lease.owner, lease.generation, lease.leaseEpoch);
    return (result.changes ?? 0) === 1;
  }

  recordBootstrapReady(runId: string, generation: number, sessionKey: string): boolean {
    const run = this.getRun(runId);
    if (!run || run.generation !== generation) return false;
    this.db.prepare(`INSERT INTO coordinator_sessions(run_id, generation, session_key, state, updated_at) VALUES (?, ?, ?, 'BOOTSTRAP_READY', ?)
      ON CONFLICT(run_id, generation, session_key) DO UPDATE SET state='BOOTSTRAP_READY', updated_at=excluded.updated_at`)
      .run(runId, generation, sessionKey, now());
    return true;
  }

  acceptRuntime(runId: string, generation: number, leaseEpoch: number, sessionKey: string): boolean {
    const ready = this.db.prepare(`SELECT 1 FROM coordinator_sessions WHERE run_id=? AND generation=? AND session_key=? AND state='BOOTSTRAP_READY'`).get(runId, generation, sessionKey);
    if (!ready) return false;
    const lease = this.db.prepare("SELECT 1 FROM coordinator_leases WHERE run_id=? AND generation=? AND lease_epoch=? AND expires_at > ?").get(runId, generation, leaseEpoch, now());
    if (!lease) return false;
    const result = this.db.prepare(`UPDATE coordinator_sessions SET state='RUNTIME_ACCEPTED', updated_at=? WHERE run_id=? AND generation=? AND session_key=? AND state='BOOTSTRAP_READY'`).run(now(), runId, generation, sessionKey);
    return (result.changes ?? 0) === 1;
  }

  appendEvent(runId: string, generation: number, leaseEpoch: number, expectedSequence: number, type: string, payload: Record<string, unknown>): CoordinatorEvent | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.db.prepare("SELECT * FROM coordinator_runs WHERE run_id=?").get(runId);
      if (!run || asNumber(run.generation) !== generation || asNumber(run.lease_epoch) !== leaseEpoch || asNumber(run.sequence) !== expectedSequence || ["requeue", "quarantined", "done"].includes(asString(run.status))) { this.db.exec("ROLLBACK"); return null; }
      const sequence = expectedSequence + 1;
      const createdAt = now();
      this.db.prepare("INSERT INTO coordinator_events(run_id,generation,lease_epoch,sequence,type,payload_json,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(runId, generation, leaseEpoch, sequence, type, JSON.stringify(payload), createdAt);
      this.db.prepare("UPDATE coordinator_runs SET sequence=?, status='running', updated_at=? WHERE run_id=? AND generation=? AND lease_epoch=? AND sequence=?")
        .run(sequence, createdAt, runId, generation, leaseEpoch, expectedSequence);
      this.db.exec("COMMIT");
      return { runId, generation, leaseEpoch, sequence, type, payload, createdAt };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  enqueueOutbox(runId: string, idempotencyKey: string, payload: Record<string, unknown>): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO coordinator_outbox(idempotency_key,run_id,payload_json,created_at) VALUES(?,?,?,?)")
      .run(idempotencyKey, runId, JSON.stringify(payload), now());
    return (result.changes ?? 0) === 1;
  }

  recordArtifact(runId: string, generation: number, kind: string, evidence: Record<string, unknown>): boolean {
    const result = this.db.prepare("INSERT OR REPLACE INTO coordinator_artifacts(run_id,generation,kind,evidence_json,created_at) VALUES(?,?,?,?,?)")
      .run(runId, generation, kind, JSON.stringify(evidence), now());
    return (result.changes ?? 0) === 1;
  }

  recordQa(runId: string, generation: number, gate: string, passed: boolean, evidence: Record<string, unknown>): boolean {
    const result = this.db.prepare("INSERT OR REPLACE INTO coordinator_qa(run_id,generation,gate,passed,evidence_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(runId, generation, gate, passed ? 1 : 0, JSON.stringify(evidence), now());
    return (result.changes ?? 0) === 1;
  }

  recordDeploy(runId: string, generation: number, environment: string, evidence: Record<string, unknown>): boolean {
    const result = this.db.prepare("INSERT OR REPLACE INTO coordinator_deploy(run_id,generation,environment,evidence_json,created_at) VALUES(?,?,?,?,?)")
      .run(runId, generation, environment, JSON.stringify(evidence), now());
    return (result.changes ?? 0) === 1;
  }

  quarantine(runId: string, generation: number, reason: string): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO coordinator_quarantine(run_id,generation,reason,created_at) VALUES(?,?,?,?)").run(runId, generation, reason, now());
    this.db.prepare("UPDATE coordinator_runs SET status='quarantined', updated_at=? WHERE run_id=? AND generation=?").run(now(), runId, generation);
    return (result.changes ?? 0) === 1;
  }

  recoverExpiredLeases(at = now()): CoordinatorRecovery[] {
    const rows = this.db.prepare(`SELECT r.run_id, r.issue_id, r.generation FROM coordinator_runs r
      JOIN coordinator_leases l ON l.run_id=r.run_id AND l.generation=r.generation
      WHERE l.expires_at <= ? AND r.status NOT IN ('done','quarantined')`).all(at);
    const recoveries: CoordinatorRecovery[] = [];
    for (const row of rows) {
      const runId = asString(row.run_id); const issueId = asString(row.issue_id); const generation = asNumber(row.generation);
      this.db.prepare("DELETE FROM coordinator_leases WHERE run_id=? AND generation=?").run(runId, generation);
      // Advance the epoch when recovering an expired lease.  Deleting the lease
      // alone is not enough: an in-flight owner may retry with the old epoch
      // after recovery and otherwise reacquire the run before the queue tick
      // creates a new generation.
      this.db.prepare("UPDATE coordinator_runs SET lease_epoch=lease_epoch+1, status='requeue', updated_at=? WHERE run_id=? AND generation=?").run(now(), runId, generation);
      recoveries.push({ runId, issueId, generation, action: "requeue", reason: "lease_expired" });
    }
    return recoveries;
  }
}
