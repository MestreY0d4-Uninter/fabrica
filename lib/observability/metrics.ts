import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "../setup/constants.js";
import { readProjects } from "../projects/index.js";

export type FabricaMetrics = {
  entriesScanned: number;
  dispatches: number;
  completions: {
    total: number;
    done: number;
    pass: number;
    fail: number;
    other: number;
  };
  avgDispatchToCompletionMinutes: number | null;
  avgDispatchToFirstPrMinutes: number | null;
  conflictsDetected: number;
  sessionBudgetResets: number;
  humanEscalations: number;
  causeCounts: Record<string, number>;
  stackMetrics: Record<string, {
    issues: number;
    dispatches: number;
    escalations: number;
    causeCounts: Record<string, number>;
    avgDispatchToCompletionMinutes: number | null;
    avgDispatchToFirstPrMinutes: number | null;
  }>;
  auditLogPath: string;
};

type AuditEntry = {
  ts: string;
  event: string;
  issue?: number;
  issueId?: number | string;
  project?: string;
  projectSlug?: string;
  role?: string;
  result?: string;
  reason?: string;
  stack?: string;
  convergenceCause?: string;
  convergenceAction?: string;
  [key: string]: unknown;
};

async function readAuditLines(filePath: string): Promise<AuditEntry[]> {
  const entries: AuditEntry[] = [];
  try {
    const content = await readFile(filePath, "utf-8");
    for (const line of content.split("\n").filter(Boolean)) {
      try { entries.push(JSON.parse(line) as AuditEntry); } catch {}
    }
  } catch {}
  return entries;
}

function keyFor(entry: AuditEntry): string | null {
  const projectSlug = entry.projectSlug ?? entry.project ?? null;
  const issueId = entry.issueId ?? entry.issue ?? null;
  if (!projectSlug || issueId == null) return null;
  return `${projectSlug}:${issueId}`;
}

function normalizeCause(entry: AuditEntry): string | null {
  const cause = entry.convergenceCause ?? entry.reason ?? null;
  return cause ? String(cause) : null;
}

export async function computeMetrics(workspaceDir: string): Promise<FabricaMetrics> {
  const auditLogPath = join(workspaceDir, DATA_DIR, "log", "audit.log");
  const bakEntries3 = await readAuditLines(`${auditLogPath}.3.bak`);
  const bakEntries2 = await readAuditLines(`${auditLogPath}.2.bak`);
  const bakEntries = await readAuditLines(`${auditLogPath}.bak`);
  const currentEntries = await readAuditLines(auditLogPath);
  const entries: AuditEntry[] = [...bakEntries3, ...bakEntries2, ...bakEntries, ...currentEntries];

  const projectsData = await readProjects(workspaceDir).catch(() => ({ projects: {} }));
  const stackByProject = new Map<string, string>();
  for (const [slug, project] of Object.entries(projectsData.projects ?? {})) {
    const stack = project.stack ?? project.environment?.stack ?? null;
    if (stack) stackByProject.set(slug, String(stack));
  }

  const entriesScanned = entries.length;
  let dispatches = 0;
  let completionsTotal = 0;
  let completionsDone = 0;
  let completionsPass = 0;
  let completionsFail = 0;
  let completionsOther = 0;
  let conflictsDetected = 0;
  let sessionBudgetResets = 0;
  let humanEscalations = 0;
  const causeCounts: Record<string, number> = {};
  const dispatchTimes = new Map<string, number>();
  const firstPrTimes = new Map<string, number>();
  const completionDeltas: number[] = [];
  const firstPrDeltas: number[] = [];
  const stackMetrics = new Map<string, {
    issues: Set<string>;
    dispatches: number;
    escalations: number;
    causeCounts: Record<string, number>;
    completionDeltas: number[];
    firstPrDeltas: number[];
  }>();

  function stackBucket(entry: AuditEntry): string {
    const slug = entry.projectSlug ?? entry.project ?? null;
    const stack = entry.stack ?? (slug ? stackByProject.get(String(slug)) : null) ?? "unknown";
    if (!stackMetrics.has(String(stack))) {
      stackMetrics.set(String(stack), {
        issues: new Set(),
        dispatches: 0,
        escalations: 0,
        causeCounts: {},
        completionDeltas: [],
        firstPrDeltas: [],
      });
    }
    return String(stack);
  }

  for (const entry of entries) {
    const issueKey = keyFor(entry);
    const stack = stackBucket(entry);
    const stackBucketState = stackMetrics.get(stack)!;
    if (issueKey) stackBucketState.issues.add(issueKey);

    switch (entry.event) {
      case "dispatch": {
        dispatches++;
        stackBucketState.dispatches++;
        if (issueKey) dispatchTimes.set(issueKey, Date.parse(entry.ts));
        break;
      }
      case "work_finish": {
        completionsTotal++;
        const result = String(entry.result ?? "");
        if (result === "done") completionsDone++;
        else if (result === "pass") completionsPass++;
        else if (result === "fail") completionsFail++;
        else completionsOther++;
        if (issueKey) {
          const dispatchTime = dispatchTimes.get(issueKey);
          const completionTime = Date.parse(entry.ts);
          if (dispatchTime !== undefined && !Number.isNaN(completionTime) && completionTime > dispatchTime) {
            const delta = (completionTime - dispatchTime) / 60_000;
            completionDeltas.push(delta);
            stackBucketState.completionDeltas.push(delta);
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
      case "pr_discovered_via_polling":
      case "pr_updated_via_polling": {
        if (issueKey && !firstPrTimes.has(issueKey)) {
          const prTime = Date.parse(entry.ts);
          const dispatchTime = dispatchTimes.get(issueKey);
          firstPrTimes.set(issueKey, prTime);
          if (dispatchTime !== undefined && !Number.isNaN(prTime) && prTime > dispatchTime) {
            const delta = (prTime - dispatchTime) / 60_000;
            firstPrDeltas.push(delta);
            stackBucketState.firstPrDeltas.push(delta);
          }
        }
        break;
      }
      case "worker_completion_skipped":
      case "doctor_snapshot":
      case "health_fix_applied": {
        const cause = normalizeCause(entry);
        if (cause) {
          causeCounts[cause] = (causeCounts[cause] ?? 0) + 1;
          stackBucketState.causeCounts[cause] = (stackBucketState.causeCounts[cause] ?? 0) + 1;
        }
        if (entry.convergenceAction === "escalate_human" || entry.action === "escalate_human") {
          humanEscalations++;
          stackBucketState.escalations++;
        }
        break;
      }
    }
  }

  const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

  const stackMetricsObject = Object.fromEntries(
    [...stackMetrics.entries()].map(([stack, data]) => [stack, {
      issues: data.issues.size,
      dispatches: data.dispatches,
      escalations: data.escalations,
      causeCounts: data.causeCounts,
      avgDispatchToCompletionMinutes: avg(data.completionDeltas),
      avgDispatchToFirstPrMinutes: avg(data.firstPrDeltas),
    }]),
  );

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
    avgDispatchToCompletionMinutes: avg(completionDeltas),
    avgDispatchToFirstPrMinutes: avg(firstPrDeltas),
    conflictsDetected,
    sessionBudgetResets,
    humanEscalations,
    causeCounts,
    stackMetrics: stackMetricsObject,
    auditLogPath,
  };
}

export function formatMetrics(metrics: FabricaMetrics): string {
  const lines: string[] = [
    `Fabrica — Métricas (${metrics.entriesScanned} entradas do audit.log)`,
    `  Dispatches: ${metrics.dispatches}`,
  ];
  const c = metrics.completions;
  lines.push(`  Conclusões: ${c.total} (done: ${c.done}, pass: ${c.pass}, fail: ${c.fail}${c.other > 0 ? `, other: ${c.other}` : ""})`);
  lines.push(`  Tempo médio dispatch → completion: ${metrics.avgDispatchToCompletionMinutes?.toFixed(1) ?? "n/a"} min`);
  lines.push(`  Tempo médio dispatch → primeira PR: ${metrics.avgDispatchToFirstPrMinutes?.toFixed(1) ?? "n/a"} min`);
  lines.push(`  Conflitos detectados: ${metrics.conflictsDetected}`);
  lines.push(`  Session budget resets: ${metrics.sessionBudgetResets}`);
  lines.push(`  Escalonamentos humanos: ${metrics.humanEscalations}`);
  if (Object.keys(metrics.causeCounts).length > 0) {
    lines.push("  Causas tipadas:");
    for (const [cause, count] of Object.entries(metrics.causeCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`    - ${cause}: ${count}`);
    }
  }
  if (Object.keys(metrics.stackMetrics).length > 0) {
    lines.push("  Por stack:");
    for (const [stack, data] of Object.entries(metrics.stackMetrics)) {
      lines.push(`    - ${stack}: issues=${data.issues}, dispatches=${data.dispatches}, escalations=${data.escalations}, avgPR=${data.avgDispatchToFirstPrMinutes?.toFixed(1) ?? "n/a"}m, avgDone=${data.avgDispatchToCompletionMinutes?.toFixed(1) ?? "n/a"}m`);
    }
  }
  return lines.join("\n");
}
