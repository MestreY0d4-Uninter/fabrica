import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkWorkerHealth, isDispatchUnconfirmed } from "../../lib/services/heartbeat/health.js";
import type { SessionLookup } from "../../lib/services/gateway-sessions.js";
import { createTestHarness, type TestHarness } from "../../lib/testing/index.js";
import { DATA_DIR } from "../../lib/setup/constants.js";
import { writeProjects } from "../../lib/projects/index.js";

async function readAuditEvents(workspaceDir: string): Promise<Array<Record<string, unknown>>> {
  const filePath = path.join(workspaceDir, DATA_DIR, "log", "audit.log");
  const content = await fs.readFile(filePath, "utf-8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("checkWorkerHealth", () => {
  let h: TestHarness | null = null;

  afterEach(async () => {
    if (h) await h.cleanup();
    h = null;
  });

  it("does not classify a live session with missing updatedAt as stalled", async () => {
    h = await createTestHarness({
      workers: {
        developer: {
          active: true,
          issueId: "42",
          sessionKey: "agent:main:subagent:test-project-developer-senior-ada",
          level: "senior",
          startTime: new Date(Date.now() - 10 * 60_000).toISOString(),
        },
      },
    });
    h.provider.seedIssue({ iid: 42, title: "Recover session timestamps", labels: ["Doing"] });

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: null,
          percentUsed: 10,
          totalTokens: 100,
          contextTokens: 1000,
        },
      ],
    ]);

    const fixes = await checkWorkerHealth({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      project: h.project,
      role: "developer",
      autoFix: true,
      provider: h.provider,
      sessions,
      staleWorkerHours: 999,
      stallTimeoutMinutes: 1,
      runCommand: h.runCommand,
      agentId: "main",
    });

    expect(fixes).toHaveLength(0);
    expect(h.commands.taskMessages()).toHaveLength(0);
    expect(h.provider.callsTo("transitionLabel")).toHaveLength(0);
  });

  it("deactivates slot and requeues after MAX_STALL_NUDGES × stallThreshold idle time (model_unresponsive)", async () => {
    // MAX_STALL_NUDGES = 3, stallTimeoutMinutes = 1 → model_unresponsive threshold = 3 min
    // Session idle for 4 min > 3 min threshold → model_unresponsive
    h = await createTestHarness({
      workers: {
        developer: {
          active: true,
          issueId: "42",
          sessionKey: "agent:main:subagent:test-project-developer-senior-ada",
          level: "senior",
          startTime: new Date(Date.now() - 60 * 60_000).toISOString(),
          previousLabel: "To Do",
        },
      },
    });
    h.provider.seedIssue({ iid: 42, title: "Quota-exhausted model", labels: ["Doing"] });

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: Date.now() - 4 * 60_000, // 4 min idle > 3 × 1 min = model_unresponsive
          percentUsed: 1,
          totalTokens: 10,
          contextTokens: 50,
        },
      ],
    ]);

    const fixes = await checkWorkerHealth({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      project: h.project,
      role: "developer",
      autoFix: true,
      provider: h.provider,
      sessions,
      staleWorkerHours: 999,
      stallTimeoutMinutes: 1,
      runCommand: h.runCommand,
      agentId: "main",
    });

    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.issue.type).toBe("model_unresponsive");
    expect(fixes[0]?.fixed).toBe(true);
    expect(fixes[0]?.nudgeSent).toBeUndefined();

    // Issue should be requeued
    const transitions = h.provider.callsTo("transitionLabel");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.args).toMatchObject({ issueId: 42, from: "Doing" });

    // Slot should be deactivated
    const afterData = await h.readProjects();
    const afterSlot = afterData.projects[h.project.slug]?.workers.developer.levels.senior?.[0];
    expect(afterSlot?.active).toBe(false);

    const events = await readAuditEvents(h.workspaceDir);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "model_unresponsive",
          action: "requeue_after_max_stall_intervals",
        }),
        expect.objectContaining({
          event: "health_fix_applied",
          type: "model_unresponsive",
          action: "requeue_issue",
        }),
      ]),
    );

    // No nudge should be sent
    expect(h.commands.taskMessages()).toHaveLength(0);
  });

  it("sends nudge (not model_unresponsive) when idle is between 1× and 3× stall threshold", async () => {
    // stallTimeoutMinutes = 5 → stall at 5 min, model_unresponsive at 15 min (slot age based)
    // Session idle for 6 min → inside stall window but below model_unresponsive threshold
    // startTime = 10 min ago (past 5 min grace period, under 15 min model_unresponsive)
    h = await createTestHarness({
      workers: {
        developer: {
          active: true,
          issueId: "42",
          sessionKey: "agent:main:subagent:test-project-developer-senior-ada",
          level: "senior",
          startTime: new Date(Date.now() - 10 * 60_000).toISOString(),
        },
      },
    });
    h.provider.seedIssue({ iid: 42, title: "Stalling worker", labels: ["Doing"] });

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: Date.now() - 6 * 60_000, // 6 min idle — stalled but < 3× threshold
          percentUsed: 5,
          totalTokens: 100,
          contextTokens: 500,
        },
      ],
    ]);

    const fixes = await checkWorkerHealth({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      project: h.project,
      role: "developer",
      autoFix: true,
      provider: h.provider,
      sessions,
      staleWorkerHours: 999,
      stallTimeoutMinutes: 5,
      runCommand: h.runCommand,
      agentId: "main",
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.issue.type).toBe("session_stalled");
    expect(fixes[0]?.nudgeSent).toBe(true);
    // Slot stays active (nudge only)
    expect(h.provider.callsTo("transitionLabel")).toHaveLength(0);
  });

  it("nudges stalled sessions conservatively instead of requeueing on low context tokens", async () => {
    // stallTimeoutMinutes: 10 → model_unresponsive threshold = 30 min (slot age based)
    // Session idle 20 min → stalled (>10 min) but not model_unresponsive (<30 min) → nudge
    // startTime = 20 min ago (slot age < 30 min model_unresponsive threshold)
    h = await createTestHarness({
      workers: {
        developer: {
          active: true,
          issueId: "42",
          sessionKey: "agent:main:subagent:test-project-developer-senior-ada",
          level: "senior",
          startTime: new Date(Date.now() - 20 * 60_000).toISOString(),
        },
      },
    });
    h.provider.seedIssue({ iid: 42, title: "Investigate idle worker", labels: ["Doing"] });

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: Date.now() - 20 * 60_000, // 20 min idle
          percentUsed: 1,
          totalTokens: 10,
          contextTokens: 50,
        },
      ],
    ]);

    const fixes = await checkWorkerHealth({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      project: h.project,
      role: "developer",
      autoFix: true,
      provider: h.provider,
      sessions,
      staleWorkerHours: 999,
      stallTimeoutMinutes: 10, // model_unresponsive at 30 min; 20 min idle → nudge only
      runCommand: h.runCommand,
      agentId: "main",
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.issue.type).toBe("session_stalled");
    expect(fixes[0]?.fixed).toBe(true);
    expect(fixes[0]?.nudgeSent).toBe(true);
    expect(h.provider.callsTo("transitionLabel")).toHaveLength(0);

    const data = await h.readProjects();
    const slot = data.projects[h.project.slug]?.workers.developer.levels.senior?.[0];
    expect(slot?.active).toBe(true);

    const taskMessages = h.commands.taskMessages();
    expect(taskMessages).toHaveLength(1);
    expect(taskMessages[0]).toContain("You appear to have stalled");

    const events = await readAuditEvents(h.workspaceDir);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "session_stalled",
          action: "nudge",
          deliveryState: "unknown",
        }),
        expect.objectContaining({
          event: "health_fix_applied",
          type: "session_stalled",
          action: "nudge_session",
          deliveryState: "unknown",
          nudgeSent: true,
        }),
      ]),
    );
  });

  it("emits health_fix_applied when a dead session is requeued", async () => {
    h = await createTestHarness({
      workers: {
        developer: {
          active: true,
          issueId: "42",
          sessionKey: "agent:main:subagent:test-project-developer-senior-ada",
          level: "senior",
          startTime: new Date(Date.now() - 20 * 60_000).toISOString(),
          previousLabel: "To Improve",
        },
      },
    });
    h.provider.seedIssue({ iid: 42, title: "Recover dead session", labels: ["Doing"] });

    const fixes = await checkWorkerHealth({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      project: h.project,
      role: "developer",
      autoFix: true,
      provider: h.provider,
      sessions: new Map(),
      staleWorkerHours: 999,
      stallTimeoutMinutes: 1,
      runCommand: h.runCommand,
      agentId: "main",
    });

    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.issue.type).toBe("session_dead");
    expect(fixes[0]?.fixed).toBe(true);

    const transitions = h.provider.callsTo("transitionLabel");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.args).toEqual({
      issueId: 42,
      from: "Doing",
      to: "To Improve",
    });

    const events = await readAuditEvents(h.workspaceDir);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "health_fix_applied",
          type: "session_dead",
          action: "requeue_issue",
          fromLabel: "Doing",
          toLabel: "To Improve",
        }),
      ]),
    );
  });

  it("requeues an active issue when dispatch never reaches agent bootstrap", async () => {
    h = await createTestHarness({
      workers: {
        developer: {
          active: true,
          issueId: "42",
          sessionKey: "agent:main:subagent:test-project-developer-senior-ada",
          level: "senior",
          startTime: new Date(Date.now() - 10 * 60_000).toISOString(),
          previousLabel: "To Do",
        },
      },
    });
    h.provider.seedIssue({ iid: 42, title: "Recover unconfirmed dispatch", labels: ["Doing"] });

    const data = await h.readProjects();
    data.projects[h.project.slug]!.issueRuntime = {
      "42": {
        dispatchRequestedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        lastSessionKey: "agent:main:subagent:test-project-developer-senior-ada",
      },
    };
    await writeProjects(h.workspaceDir, data);

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: Date.now() - 10 * 60_000,
          percentUsed: 5,
          totalTokens: 100,
          contextTokens: 500,
        },
      ],
    ]);

    const fixes = await checkWorkerHealth({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      project: data.projects[h.project.slug]!,
      role: "developer",
      autoFix: true,
      provider: h.provider,
      sessions,
      staleWorkerHours: 999,
      stallTimeoutMinutes: 30,
      runCommand: h.runCommand,
      agentId: "main",
    });

    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.issue.type).toBe("dispatch_unconfirmed");
    expect(fixes[0]?.fixed).toBe(true);

    const transitions = h.provider.callsTo("transitionLabel");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.args).toEqual({
      issueId: 42,
      from: "Doing",
      to: "To Do",
    });
  });
});

import { isSessionExhausted } from "../../lib/services/heartbeat/health.js";

describe("isSessionExhausted", () => {
  it("returns true when percentUsed >= 0.98 without abort or completion", () => {
    expect(isSessionExhausted({ percentUsed: 0.99 })).toBe(true);
    expect(isSessionExhausted({ percentUsed: 0.98 })).toBe(true);
  });

  it("returns false when abortedLastRun is true (handled by context_overflow already)", () => {
    expect(isSessionExhausted({ percentUsed: 0.99, abortedLastRun: true })).toBe(false);
  });

  it("returns false when percentUsed is below threshold", () => {
    expect(isSessionExhausted({ percentUsed: 0.5 })).toBe(false);
  });

  it("returns false when session completed normally", () => {
    expect(isSessionExhausted({ percentUsed: 0.99, sessionCompletedAt: "2026-03-17T00:00:00Z" })).toBe(false);
  });

  it("returns false when percentUsed is undefined", () => {
    expect(isSessionExhausted({})).toBe(false);
  });
});

describe("isDispatchUnconfirmed (configurable timeout)", () => {
  it("returns true when elapsed > timeoutMs", () => {
    const dispatchedAt = Date.now() - 70_000; // 70s ago
    expect(isDispatchUnconfirmed(dispatchedAt, 60_000)).toBe(true);
  });

  it("returns false when elapsed < timeoutMs", () => {
    const dispatchedAt = Date.now() - 30_000; // 30s ago
    expect(isDispatchUnconfirmed(dispatchedAt, 60_000)).toBe(false);
  });

  it("uses DISPATCH_CONFIRMATION_TIMEOUT_MS default when no timeout given", () => {
    // Worker dispatched 3 minutes ago — should be unconfirmed (default is 2min)
    const dispatchedAt = Date.now() - 3 * 60_000;
    expect(isDispatchUnconfirmed(dispatchedAt)).toBe(true);
  });
});

describe("performHealthPass — dispatchConfirmTimeoutMs propagation", () => {
  it("passes dispatchConfirmTimeoutMs from resolvedConfig into checkWorkerHealth", async () => {
    const { performHealthPass } = await import("../../lib/services/heartbeat/passes.js");
    const healthModule = await import("../../lib/services/heartbeat/health.js");
    const spy = vi.spyOn(healthModule, "checkWorkerHealth").mockResolvedValue([]);
    vi.spyOn(healthModule, "scanOrphanedLabels").mockResolvedValue([]);
    vi.spyOn(healthModule, "scanStatelessIssues").mockResolvedValue([]);

    const project = {
      workers: { developer: { levels: {} } },
      channels: [],
      slug: "test",
      name: "test",
    } as any;
    const provider = {
      listIssues: vi.fn().mockResolvedValue([]),
    } as any;
    const resolvedConfig = {
      timeouts: { dispatchConfirmTimeoutMs: 9999, staleWorkerHours: 1, stallTimeoutMinutes: 5 },
      workflow: { states: {} },
    } as any;

    await performHealthPass(".", "test", project, null, provider, undefined, undefined, undefined, undefined, undefined, resolvedConfig);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchConfirmTimeoutMs: 9999 }),
    );
    spy.mockRestore();
  });
});
