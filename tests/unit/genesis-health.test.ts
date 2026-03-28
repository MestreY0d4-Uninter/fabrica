import { describe, it, expect } from "vitest";
import { detectStaleBootstrapSessions } from "../../lib/services/heartbeat/genesis-health.js";

describe("detectStaleBootstrapSessions", () => {
  it("returns sessions stuck in pending_classify for more than 5 minutes", () => {
    const sessions = [
      { id: "telegram:123", status: "pending_classify", updatedAt: Date.now() - 6 * 60_000 },
      { id: "telegram:456", status: "pending_classify", updatedAt: Date.now() - 2 * 60_000 },
    ];
    const stale = detectStaleBootstrapSessions(sessions);
    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe("telegram:123");
  });

  it("returns sessions stuck in classifying for more than 5 minutes", () => {
    const sessions = [
      { id: "telegram:789", status: "classifying", updatedAt: Date.now() - 10 * 60_000 },
    ];
    const stale = detectStaleBootstrapSessions(sessions);
    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe("telegram:789");
  });

  it("ignores completed and failed sessions regardless of age", () => {
    const sessions = [
      { id: "telegram:1", status: "completed", updatedAt: Date.now() - 60 * 60_000 },
      { id: "telegram:2", status: "failed", updatedAt: Date.now() - 60 * 60_000 },
    ];
    expect(detectStaleBootstrapSessions(sessions)).toHaveLength(0);
  });

  it("ignores recent pending_classify sessions (under 5 minutes)", () => {
    const sessions = [
      { id: "telegram:3", status: "pending_classify", updatedAt: Date.now() - 2 * 60_000 },
    ];
    expect(detectStaleBootstrapSessions(sessions)).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    expect(detectStaleBootstrapSessions([])).toHaveLength(0);
  });
});
