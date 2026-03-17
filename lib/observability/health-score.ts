/**
 * observability/health-score.ts — Composite health score (0-100).
 *
 * Weighted signals:
 *   Completion rate:      25%
 *   Dispatch speed:       20%
 *   Error rate:           20%
 *   Queue depth:          15%
 *   Heartbeat regularity: 20%
 */

export type HealthSignalInput = {
  completionRate: number | null;
  avgDispatchToCompletionMinutes: number | null;
  baselineMinutes: number;
  errorRate: number | null;
  queueDepth: number;
  maxQueueDepth: number;
  heartbeatRegularity: number | null;
};

export type HealthScoreResult = {
  score: number;
  status: "healthy" | "degraded" | "unhealthy";
  signals: Array<{ name: string; raw: number | null; weighted: number }>;
};

/**
 * Compute composite health score.
 * Returns 50 (neutral) when no data is available.
 */
export function computeHealthScore(input: HealthSignalInput): HealthScoreResult {
  const signals: HealthScoreResult["signals"] = [];
  let totalWeight = 0;
  let weightedSum = 0;
  // Tracks whether any "meaningful" telemetry signal (not queue depth, which is always
  // derivable from runtime counters) has been provided.
  let hasMeaningfulData = false;

  function addSignal(name: string, raw: number | null, weight: number, meaningful = true) {
    if (raw === null) {
      signals.push({ name, raw, weighted: 0 });
      return;
    }
    if (meaningful) hasMeaningfulData = true;
    const clamped = Math.max(0, Math.min(1, raw));
    const weighted = clamped * weight * 100;
    signals.push({ name, raw, weighted });
    totalWeight += weight;
    weightedSum += weighted;
  }

  addSignal("completion_rate", input.completionRate, 0.25);

  const speedRatio =
    input.avgDispatchToCompletionMinutes !== null && input.avgDispatchToCompletionMinutes > 0
      ? Math.min(1, input.baselineMinutes / input.avgDispatchToCompletionMinutes)
      : null;
  addSignal("dispatch_speed", speedRatio, 0.20);

  const errorScore = input.errorRate !== null ? 1 - input.errorRate : null;
  addSignal("error_rate", errorScore, 0.20);

  // Queue depth is always computable; not counted as "meaningful" for the no-data guard
  const queueScore =
    input.maxQueueDepth > 0 ? 1 - Math.min(1, input.queueDepth / input.maxQueueDepth) : 1;
  addSignal("queue_depth", queueScore, 0.15, false);

  addSignal("heartbeat_regularity", input.heartbeatRegularity, 0.20);

  if (!hasMeaningfulData) {
    return { score: 50, status: "degraded", signals };
  }

  const score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 50;
  const status = score > 80 ? "healthy" : score >= 50 ? "degraded" : "unhealthy";

  return { score, status, signals };
}
