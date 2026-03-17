import { describe, it, expect } from "vitest";
import { computeHealthScore, type HealthSignalInput } from "../../lib/observability/health-score.js";

const healthy: HealthSignalInput = {
  completionRate: 0.9,
  avgDispatchToCompletionMinutes: 20,
  baselineMinutes: 30,
  errorRate: 0.05,
  queueDepth: 2,
  maxQueueDepth: 20,
  heartbeatRegularity: 0.95,
};

describe("computeHealthScore", () => {
  it("returns healthy (>80) for good signals", () => {
    const { score, status } = computeHealthScore(healthy);
    expect(score).toBeGreaterThan(80);
    expect(status).toBe("healthy");
  });

  it("returns degraded (50-80) for moderate issues", () => {
    const { score, status } = computeHealthScore({
      ...healthy,
      completionRate: 0.5,
      errorRate: 0.3,
    });
    expect(score).toBeGreaterThanOrEqual(50);
    expect(score).toBeLessThanOrEqual(80);
    expect(status).toBe("degraded");
  });

  it("returns unhealthy (<50) for severe issues", () => {
    const { score, status } = computeHealthScore({
      ...healthy,
      completionRate: 0.1,
      errorRate: 0.8,
      heartbeatRegularity: 0.2,
    });
    expect(score).toBeLessThan(50);
    expect(status).toBe("unhealthy");
  });

  it("returns neutral (50) when no data", () => {
    const { score } = computeHealthScore({
      completionRate: null,
      avgDispatchToCompletionMinutes: null,
      baselineMinutes: 30,
      errorRate: null,
      queueDepth: 0,
      maxQueueDepth: 20,
      heartbeatRegularity: null,
    });
    expect(score).toBe(50);
  });
});
