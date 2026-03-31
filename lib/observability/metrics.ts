/**
 * observability/metrics.ts — Compute operational metrics from the audit log.
 *
 * audit.log remains Fabrica's authoritative durable trail today. This module
 * intentionally reads audit.log instead of events.ndjson because the structured
 * event log is not yet wired into live transitions.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "../setup/constants.js";

export type FabricaMetrics = {
  /** Total number of audit log entries scanned */
  entriesScanned: number;
  /** Number of dispatch events */
  dispatches: number;
  /** Completion breakdown */
  completions: {
    total: number;
    done: number;
    pass: number;
    fail: number;
    other: number;
  };
  /** Average time from dispatch to completion in minutes (null if no data) */
  avgDispatchToCompletionMinutes: number | null;
  /** Number of merge conflict detections */
  conflictsDetected: number;
  /** Number of session context budget resets */
  sessionBudgetResets: number;
  /** Audit log path that was read */
  auditLogPath: string;
};

type AuditEntry = {
  ts: string;
  event: string;
  issue?: number;
  project?: string;
  role?: string;
  result?: string;
  [key: string]: unknown;
};

/**
 * Compute operational metrics from the audit log.
 *
 * Reads up to the last N entries from audit.log.
 */
async function readAuditLines(filePath: string): Promise<AuditEntry[]> {
  const entries: AuditEntry[] = [];
  try {
    const content = await readFile(filePath, "utf-8");
    for (const line of content.split("\n").filter(Boolean)) {
      try { entries.push(JSON.parse(line) as AuditEntry); } catch { /* skip malformed */ }
    }
  } catch { /* file missing — skip */ }
  return entries;
}

/**
 * Compute operational metrics from the audit log.
 *
 * Reads audit.log plus up to 2 backup files (.bak, .2.bak) to preserve
 * history across log rotations. Entries are concatenated oldest-first so
 * dispatch→completion timing calculations remain accurate (M4).
 */
export async function computeMetrics(workspaceDir: string): Promise<FabricaMetrics> {
  const auditLogPath = join(workspaceDir, DATA_DIR, "log", "audit.log");

  // Read oldest-first: .2.bak → .bak → current log
  const bakEntries2 = await readAuditLines(`${auditLogPath}.2.bak`);
  const bakEntries = await readAuditLines(`${auditLogPath}.bak`);
  const currentEntries = await readAuditLines(auditLogPath);

  let entries: AuditEntry[] = [...bakEntries2, ...bakEntries, ...currentEntries];

  const entriesScanned = entries.length;
  let dispatches = 0;
  let completionsTotal = 0;
  let completionsDone = 0;
  let completionsPass = 0;
  let completionsFail = 0;
  let completionsOther = 0;
  let conflictsDetected = 0;
  let sessionBudgetResets = 0;

  // For avg dispatch→completion: track dispatch times per (project, issueId)
  const dispatchTimes = new Map<string, number>();
  const completionDeltas: number[] = [];

  for (const entry of entries) {
    switch (entry.event) {
      case "dispatch":
        dispatches++;
        if (entry.issue != null && entry.project) {
          dispatchTimes.set(`${entry.project}:${entry.issue}`, Date.parse(entry.ts));
        }
        break;

      case "work_finish": {
        completionsTotal++;
        const result = String(entry.result ?? "");
        if (result === "done") completionsDone++;
        else if (result === "pass") completionsPass++;
        else if (result === "fail") completionsFail++;
        else completionsOther++;

        if (entry.issue != null && entry.project) {
          const key = `${entry.project}:${entry.issue}`;
          const dispatchTime = dispatchTimes.get(key);
          if (dispatchTime !== undefined) {
            const completionTime = Date.parse(entry.ts);
            if (!isNaN(completionTime) && completionTime > dispatchTime) {
              completionDeltas.push((completionTime - dispatchTime) / 60_000);
            }
          }
        }
        break;
      }

      case "review_transition":
        if (entry.reason === "merge_conflict") conflictsDetected++;
        break;

      case "conflict_cycle_detected":
        conflictsDetected++;
        break;

      case "session_budget_reset":
        sessionBudgetResets++;
        break;
    }
  }

  const avgDispatchToCompletionMinutes =
    completionDeltas.length > 0
      ? completionDeltas.reduce((a, b) => a + b, 0) / completionDeltas.length
      : null;

  return {
    entriesScanned,
    dispatches,
    completions: {
      total: completionsTotal,
      done: completionsDone,
      pass: completionsPass,
      fail: completionsFail,
      other: completionsOther,
    },
    avgDispatchToCompletionMinutes,
    conflictsDetected,
    sessionBudgetResets,
    auditLogPath,
  };
}

/**
 * Format metrics for human-readable console output.
 */
export function formatMetrics(metrics: FabricaMetrics): string {
  const lines: string[] = [
    `Fabrica — Metricas (${metrics.entriesScanned} entradas do audit.log)`,
    `  Dispatches: ${metrics.dispatches}`,
  ];

  const c = metrics.completions;
  lines.push(
    `  Conclusoes: ${c.total} (done: ${c.done}, pass: ${c.pass}, fail: ${c.fail}${c.other > 0 ? `, other: ${c.other}` : ""})`,
  );

  if (metrics.avgDispatchToCompletionMinutes !== null) {
    lines.push(`  Tempo medio dispatch → completion: ${metrics.avgDispatchToCompletionMinutes.toFixed(1)} min`);
  } else {
    lines.push(`  Tempo medio dispatch → completion: n/a`);
  }

  lines.push(`  Conflitos detectados: ${metrics.conflictsDetected}`);
  lines.push(`  Session budget resets: ${metrics.sessionBudgetResets}`);

  return lines.join("\n");
}
