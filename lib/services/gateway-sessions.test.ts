import { describe, it, expect } from "vitest";
import { shouldFilterSession } from "./gateway-sessions.js";

describe("shouldFilterSession", () => {
  it("filters sessions older than gateway start in normal operation", () => {
    // Gateway running for 1 hour, session updated 2 hours ago
    const gatewayUptimeMs = 60 * 60 * 1000;
    const sessionUpdatedAt = Date.now() - 2 * 60 * 60 * 1000;
    expect(shouldFilterSession(sessionUpdatedAt, gatewayUptimeMs)).toBe(true);
  });

  it("does NOT filter recent sessions in normal operation", () => {
    // Gateway running for 1 hour, session updated 30 min ago
    const gatewayUptimeMs = 60 * 60 * 1000;
    const sessionUpdatedAt = Date.now() - 30 * 60 * 1000;
    expect(shouldFilterSession(sessionUpdatedAt, gatewayUptimeMs)).toBe(false);
  });

  it("uses softer filter during restart grace period", () => {
    // Gateway just restarted (uptime 10s), session updated 2 min ago
    const gatewayUptimeMs = 10 * 1000;
    const sessionUpdatedAt = Date.now() - 2 * 60 * 1000;
    // During grace period, only filter sessions older than RESTART_GRACE_PERIOD (5 min)
    // 2 min < 5 min → should NOT be filtered
    expect(shouldFilterSession(sessionUpdatedAt, gatewayUptimeMs)).toBe(false);
  });

  it("still filters very old sessions even during restart grace period", () => {
    // Gateway just restarted (uptime 10s), session updated 10 min ago
    const gatewayUptimeMs = 10 * 1000;
    const sessionUpdatedAt = Date.now() - 10 * 60 * 1000;
    // 10 min > 5 min grace → should be filtered
    expect(shouldFilterSession(sessionUpdatedAt, gatewayUptimeMs)).toBe(true);
  });

  it("does not filter when updatedAt is null", () => {
    const gatewayUptimeMs = 60 * 60 * 1000;
    expect(shouldFilterSession(null, gatewayUptimeMs)).toBe(false);
  });
});
