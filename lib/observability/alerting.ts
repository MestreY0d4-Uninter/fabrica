/**
 * observability/alerting.ts — Health alert decision logic.
 */

export type AlertState = {
  lastAlertTs: number;
  lastAlertScore: number;
  cooldownMs: number;
};

/**
 * Returns the alerting decision for the current score.
 * "alert"     — score below threshold AND cooldown has elapsed
 * "recovered" — score returned above 80 after a prior alert
 * "skip"      — cooldown active, score healthy, or no change
 */
export function shouldAlert(
  score: number,
  threshold: number,
  state: AlertState,
  now: number,
): "alert" | "recovered" | "skip" {
  if (score < threshold) {
    if (now - state.lastAlertTs < state.cooldownMs) return "skip";
    return "alert";
  }
  if (state.lastAlertScore < threshold && score >= 80) {
    return "recovered";
  }
  return "skip";
}
