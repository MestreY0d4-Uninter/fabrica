import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkWorkerHealth } from "../../lib/services/heartbeat/health.js";
import type { SessionLookup } from "../../lib/services/gateway-sessions.js";
import { createTestHarness, type TestHarness } from "../../lib/testing/index.js";
import { DATA_DIR } from "../../lib/setup/migrate-layout.js";
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

  it("nudges stalled sessions conservatively instead of requeueing on low context tokens", async () => {
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
          updatedAt: Date.now() - 20 * 60_000,
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
