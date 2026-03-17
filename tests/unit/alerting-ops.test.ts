import { describe, it, expect } from "vitest";
import { shouldAlert, type AlertState } from "../../lib/observability/alerting.js";

describe("alerting logic", () => {
  const state: AlertState = { lastAlertTs: 0, lastAlertScore: 85, cooldownMs: 1800_000 };

  it("sends alert when score drops below threshold", () => {
    expect(shouldAlert(45, 60, state, Date.now())).toBe("alert");
  });

  it("skips alert within cooldown", () => {
    const recent = { ...state, lastAlertTs: Date.now() - 60_000 };
    expect(shouldAlert(45, 60, recent, Date.now())).toBe("skip");
  });

  it("sends recovered when score returns above 80 after alert", () => {
    const alerted = { ...state, lastAlertScore: 45 };
    expect(shouldAlert(85, 60, alerted, Date.now())).toBe("recovered");
  });

  it("skips when score is healthy and no prior alert", () => {
    expect(shouldAlert(90, 60, state, Date.now())).toBe("skip");
  });
});
