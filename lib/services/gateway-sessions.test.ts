import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  fetchGatewaySessions,
  getLastObservableSessionActivityAt,
  isSessionAlive,
  shouldFilterSession,
  type SessionLookup,
} from "./gateway-sessions.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

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

describe("isSessionAlive", () => {
  it("treats sessions with terminal status as dead", () => {
    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: Date.now(),
          percentUsed: 10,
          status: "done",
          endedAt: Date.now(),
        },
      ],
    ]);

    expect(isSessionAlive("agent:main:subagent:test-project-developer-senior-ada", sessions)).toBe(false);
  });

  it("treats sessions without terminal markers as alive", () => {
    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: Date.now(),
          percentUsed: 10,
          status: "running",
        },
      ],
    ]);

    expect(isSessionAlive("agent:main:subagent:test-project-developer-senior-ada", sessions)).toBe(true);
  });

  it("keeps a terminal session dead but still exposes newer transcript activity separately", () => {
    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: Date.now() - 5_000,
          percentUsed: 10,
          status: "failed",
          endedAt: Date.now() - 10_000,
          sessionFile: "/tmp/demo-session.jsonl",
          sessionFileMtime: Date.now() - 1_000,
        } as any,
      ],
    ]);

    expect(isSessionAlive("agent:main:subagent:test-project-developer-senior-ada", sessions)).toBe(false);
    expect(
      getLastObservableSessionActivityAt("agent:main:subagent:test-project-developer-senior-ada", sessions),
    ).toBeGreaterThan(0);
  });

  it("preserves terminal metadata when reading sessions from disk fallback", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-gateway-sessions-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const sessionsDir = path.join(tempHome, ".openclaw", "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:subagent:test-project-developer-senior-ada": {
          updatedAt: Date.now(),
          percentUsed: 10,
          status: "done",
          endedAt: Date.now() - 1_000,
        },
      }),
      "utf-8",
    );

    try {
      const sessions = await fetchGatewaySessions(
        1,
        async () => {
          throw new Error("gateway unavailable");
        },
      );

      const session = sessions?.get("agent:main:subagent:test-project-developer-senior-ada");
      expect(session?.status).toBe("done");
      expect(session?.endedAt).toEqual(expect.any(Number));
      expect(isSessionAlive("agent:main:subagent:test-project-developer-senior-ada", sessions ?? null)).toBe(false);
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("hydrates sessionFile mtime from gateway status session paths", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-gateway-status-"));
    const sessionStorePath = path.join(tempDir, "sessions.json");
    const transcriptPath = path.join(tempDir, "session.jsonl");
    await fs.writeFile(transcriptPath, JSON.stringify({ hello: "world" }), "utf-8");
    await fs.writeFile(
      sessionStorePath,
      JSON.stringify({
        "agent:main:subagent:test-project-developer-senior-ada": {
          updatedAt: Date.now() - 10_000,
          percentUsed: 10,
          status: "running",
          sessionFile: transcriptPath,
        },
      }),
      "utf-8",
    );

    try {
      const sessions = await fetchGatewaySessions(
        1,
        async () => ({
          stdout: JSON.stringify({
            sessions: {
              paths: [sessionStorePath],
              recent: [],
            },
          }),
          stderr: "",
          code: 0,
        }),
      );

      const session = sessions?.get("agent:main:subagent:test-project-developer-senior-ada");
      expect(session?.sessionFile).toBe(transcriptPath);
      expect(session?.sessionFileMtime).toEqual(expect.any(Number));
      expect(
        getLastObservableSessionActivityAt("agent:main:subagent:test-project-developer-senior-ada", sessions ?? null),
      ).toBe(session?.sessionFileMtime);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
