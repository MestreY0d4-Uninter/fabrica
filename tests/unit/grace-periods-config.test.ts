import { describe, it, expect } from "vitest";
import type { ResolvedTimeouts } from "../../lib/config/types.js";

describe("new timeout fields", () => {
  it("ResolvedTimeouts includes healthGracePeriodMs", () => {
    const t: ResolvedTimeouts = {
      gitPullMs: 30000, gatewayMs: 15000, sessionPatchMs: 30000,
      dispatchMs: 600000, staleWorkerHours: 2, sessionContextBudget: 0.6,
      stallTimeoutMinutes: 15, sessionConfirmAttempts: 5,
      sessionConfirmDelayMs: 250, sessionLabelMaxLength: 64,
      auditLogMaxLines: 500, auditLogMaxBackups: 3, lockStaleMs: 30000,
      healthGracePeriodMs: 900000,
      dispatchConfirmTimeoutMs: 120000,
      tickTimeoutMs: 50000,
    };
    expect(t.healthGracePeriodMs).toBe(900000);
    expect(t.dispatchConfirmTimeoutMs).toBe(120000);
    expect(t.tickTimeoutMs).toBe(50000);
  });
});
