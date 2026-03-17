import { describe, it, expect } from "vitest";
import { checkProgress, type ProgressCheck } from "../../lib/services/heartbeat/health.js";

describe("dispatch progress tracking", () => {
  it("healthy when recent commits", () => {
    expect(checkProgress({ lastCommitAgeMs: 10 * 60_000, sessionActive: true })).toBe("healthy");
  });

  it("slow_progress when no commit for 30+ min", () => {
    expect(checkProgress({ lastCommitAgeMs: 45 * 60_000, sessionActive: true })).toBe("slow_progress");
  });

  it("stalled when no commit for 60+ min", () => {
    expect(checkProgress({ lastCommitAgeMs: 65 * 60_000, sessionActive: true })).toBe("stalled");
  });

  it("healthy when session not active (not our concern)", () => {
    expect(checkProgress({ lastCommitAgeMs: 90 * 60_000, sessionActive: false })).toBe("healthy");
  });
});
