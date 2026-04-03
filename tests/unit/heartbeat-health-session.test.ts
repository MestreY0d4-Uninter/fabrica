import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkWorkerHealth, isDispatchUnconfirmed } from "../../lib/services/heartbeat/health.js";
import type { SessionLookup } from "../../lib/services/gateway-sessions.js";
import { createTestHarness, type TestHarness } from "../../lib/testing/index.js";
import { DATA_DIR } from "../../lib/setup/constants.js";
import { writeProjects } from "../../lib/projects/index.js";
import { writeIntent, getPendingIntents } from "../../lib/dispatch/notification-outbox.js";

async function readAuditEvents(workspaceDir: string): Promise<Array<Record<string, unknown>>> {
  const filePath = path.join(workspaceDir, DATA_DIR, "log", "audit.log");
  let content = "";
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const VALID_DEVELOPER_QA_EVIDENCE = [
  "## QA Evidence",
  "lint",
  "types",
  "security",
  "tests",
  "coverage",
  "Total coverage: 85%",
  "Exit code: 0",
].join("\n");

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
    });

    expect(fixes).toHaveLength(0);
    expect(h.commands.taskMessages()).toHaveLength(0);
    expect(h.provider.callsTo("transitionLabel")).toHaveLength(0);
  });

  it("does not advance a healthy active slot just because a PR exists", async () => {
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
    h.provider.seedIssue({ iid: 42, title: "Keep work in Doing", labels: ["Doing"] });
    h.provider.setPrStatus(42, { state: "open", url: "https://example.com/pr/42" });

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: Date.now() - 60_000,
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
    });

    expect(fixes).toHaveLength(0);
    expect(h.provider.callsTo("transitionLabel")).toHaveLength(0);

    const issue = await h.provider.getIssue(42);
    expect(issue.labels).toContain("Doing");
    expect(issue.labels).not.toContain("To Review");

    const data = await h.readProjects();
    const slot = data.projects[h.project.slug]!.workers.developer.levels.senior?.[0];
    expect(slot?.active).toBe(true);
    expect(slot?.issueId).toBe("42");
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

  it("requeues an active issue when dispatch was accepted but never reached worker activity", async () => {
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
    h.provider.seedIssue({ iid: 42, title: "Recover accepted but idle dispatch", labels: ["Doing"] });

    const acceptedAt = Date.now() - 10 * 60_000;
    const data = await h.readProjects();
    data.projects[h.project.slug]!.issueRuntime = {
      "42": {
        dispatchRequestedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        agentAcceptedAt: new Date(acceptedAt).toISOString(),
        lastSessionKey: "agent:main:subagent:test-project-developer-senior-ada",
        firstWorkerActivityAt: null,
      },
    };
    await writeProjects(h.workspaceDir, data);

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: acceptedAt,
          percentUsed: 0,
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
    });

    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.issue.type).toBe("dispatch_unconfirmed");
    expect(fixes[0]?.fixed).toBe(true);

    const transitions = h.provider.callsTo("transitionLabel");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.args).toEqual({
      issueId: 42,
      from: "Doing",
      to: "To Improve",
    });
  });

  it("does not mark dispatch_unconfirmed after an inconclusive completion already proved worker activity", async () => {
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
    h.provider.seedIssue({ iid: 42, title: "Keep inconclusive worker alive", labels: ["Doing"] });

    const data = await h.readProjects();
    data.projects[h.project.slug]!.issueRuntime = {
      "42": {
        dispatchRequestedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        agentAcceptedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        lastSessionKey: "agent:main:subagent:test-project-developer-senior-ada",
        firstWorkerActivityAt: null,
        inconclusiveCompletionAt: new Date(Date.now() - 60_000).toISOString(),
        inconclusiveCompletionReason: "missing_result_line",
      },
    };
    await writeProjects(h.workspaceDir, data);

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: Date.now(),
          percentUsed: 0,
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
    });

    expect(fixes).toHaveLength(0);
    expect(h.provider.callsTo("transitionLabel")).toHaveLength(0);
  });

  it("requeues a live-but-silent worker only after completion recovery is exhausted", async () => {
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
    h.provider.seedIssue({ iid: 42, title: "Recover silent completion", labels: ["Doing"] });

    const inconclusiveAt = Date.now() - 5 * 60_000;
    const data = await h.readProjects();
    data.projects[h.project.slug]!.issueRuntime = {
      "42": {
        dispatchRequestedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        agentAcceptedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        lastSessionKey: "agent:main:subagent:test-project-developer-senior-ada",
        firstWorkerActivityAt: new Date(Date.now() - 9 * 60_000).toISOString(),
        inconclusiveCompletionAt: new Date(inconclusiveAt).toISOString(),
        inconclusiveCompletionReason: "missing_result_line",
      },
    };
    await writeProjects(h.workspaceDir, data);

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: inconclusiveAt - 1_000,
          percentUsed: 12,
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
      runCommand: h.runCommand,
      completionRecoveryWindowMs: 60_000,
    });

    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.issue.type).toBe("completion_recovery_exhausted");
    expect(fixes[0]?.fixed).toBe(true);

    const transitions = h.provider.callsTo("transitionLabel");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.args).toEqual({
      issueId: 42,
      from: "Doing",
      to: "To Improve",
    });

    const updated = await h.readProjects();
    expect(updated.projects[h.project.slug]!.issueRuntime?.["42"]?.inconclusiveCompletionAt).toBeNull();
    expect(updated.projects[h.project.slug]!.issueRuntime?.["42"]?.inconclusiveCompletionReason).toBeNull();

    const messageCommands = h.commands.commandsFor("openclaw");
    expect(messageCommands.some((command) => command.argv.includes("message") && command.argv.includes("send"))).toBe(true);
  });

  it("keeps invalid execution paths alive while the session still shows new activity", async () => {
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
    h.provider.seedIssue({ iid: 42, title: "Recover invalid execution path", labels: ["Doing"] });

    const inconclusiveAt = Date.now() - 75_000;
    const data = await h.readProjects();
    data.projects[h.project.slug]!.issueRuntime = {
      "42": {
        dispatchRequestedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        agentAcceptedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        lastSessionKey: "agent:main:subagent:test-project-developer-senior-ada",
        firstWorkerActivityAt: new Date(Date.now() - 9 * 60_000).toISOString(),
        inconclusiveCompletionAt: new Date(inconclusiveAt).toISOString(),
        inconclusiveCompletionReason: "invalid_execution_path",
      },
    };
    await writeProjects(h.workspaceDir, data);

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: Date.now(),
          percentUsed: 20,
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
      runCommand: h.runCommand,
      completionRecoveryWindowMs: 10 * 60_000,
    });

    expect(fixes).toHaveLength(0);
    expect(h.provider.callsTo("transitionLabel")).toHaveLength(0);
  });

  it("requeues invalid execution paths after a short quiet recovery window", async () => {
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
    h.provider.seedIssue({ iid: 42, title: "Recover invalid execution path", labels: ["Doing"] });

    const inconclusiveAt = Date.now() - 75_000;
    const data = await h.readProjects();
    data.projects[h.project.slug]!.issueRuntime = {
      "42": {
        dispatchRequestedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        agentAcceptedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        lastSessionKey: "agent:main:subagent:test-project-developer-senior-ada",
        firstWorkerActivityAt: new Date(Date.now() - 9 * 60_000).toISOString(),
        inconclusiveCompletionAt: new Date(inconclusiveAt).toISOString(),
        inconclusiveCompletionReason: "invalid_execution_path",
      },
    };
    await writeProjects(h.workspaceDir, data);

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: inconclusiveAt - 1_000,
          percentUsed: 20,
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
      runCommand: h.runCommand,
      completionRecoveryWindowMs: 10 * 60_000,
    });

    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.issue.type).toBe("execution_contract_recovery_exhausted");
    expect(fixes[0]?.fixed).toBe(true);

    const transitions = h.provider.callsTo("transitionLabel");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.args).toEqual({
      issueId: 42,
      from: "Doing",
      to: "To Improve",
    });

    const updated = await h.readProjects();
    const runtime = updated.projects[h.project.slug]!.issueRuntime?.["42"];
    const slot = updated.projects[h.project.slug]!.workers.developer.levels.senior?.[0];
    expect(runtime?.inconclusiveCompletionAt).toBeNull();
    expect(runtime?.inconclusiveCompletionReason).toBeNull();
    expect(slot?.active).toBe(false);
    expect(slot?.issueId).toBeNull();

    const events = await readAuditEvents(h.workspaceDir);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "worker_execution_recovery_exhausted",
          reason: "invalid_execution_path",
          role: "developer",
          issueId: "42",
        }),
        expect.objectContaining({
          event: "worker_execution_requeued",
          reason: "invalid_execution_path",
          role: "developer",
          issueId: "42",
        }),
      ]),
    );
  });

  it("does not requeue invalid execution path when a canonical completion line appears in the session transcript", async () => {
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
    h.provider.seedIssue({ iid: 42, title: "Wait for canonical completion", labels: ["Doing"] });

    const inconclusiveAt = Date.now() - 75_000;
    const transcriptPath = path.join(h.workspaceDir, "session-42.jsonl");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "Work result: DONE" }],
      })}\n`,
      "utf-8",
    );

    const data = await h.readProjects();
    data.projects[h.project.slug]!.issueRuntime = {
      "42": {
        dispatchRequestedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        agentAcceptedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        lastSessionKey: "agent:main:subagent:test-project-developer-senior-ada",
        firstWorkerActivityAt: new Date(Date.now() - 9 * 60_000).toISOString(),
        inconclusiveCompletionAt: new Date(inconclusiveAt).toISOString(),
        inconclusiveCompletionReason: "invalid_execution_path",
      },
    };
    await writeProjects(h.workspaceDir, data);

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: Date.now(),
          percentUsed: 20,
          totalTokens: 100,
          contextTokens: 500,
          sessionFile: transcriptPath,
          sessionFileMtime: Date.now(),
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
      runCommand: h.runCommand,
      completionRecoveryWindowMs: 10 * 60_000,
    });

    expect(fixes).toHaveLength(0);
    expect(h.provider.callsTo("transitionLabel")).toHaveLength(0);

    const updated = await h.readProjects();
    const slot = updated.projects[h.project.slug]!.workers.developer.levels.senior?.[0];
    expect(slot?.active).toBe(true);
    expect(slot?.issueId).toBe("42");

    const events = await readAuditEvents(h.workspaceDir);
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "worker_execution_recovery_exhausted" }),
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "worker_execution_requeued" }),
      ]),
    );
  });

  it("records first worker activity from a live session update after acceptance and skips dispatch_unconfirmed", async () => {
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
    h.provider.seedIssue({ iid: 42, title: "Observe live worker activity", labels: ["Doing"] });

    const acceptedAt = Date.now() - 10 * 60_000;
    const data = await h.readProjects();
    data.projects[h.project.slug]!.issueRuntime = {
      "42": {
        dispatchRequestedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        agentAcceptedAt: new Date(acceptedAt).toISOString(),
        lastSessionKey: "agent:main:subagent:test-project-developer-senior-ada",
        firstWorkerActivityAt: null,
      },
    };
    await writeProjects(h.workspaceDir, data);

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: acceptedAt + 30_000,
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
    });

    expect(fixes).toHaveLength(0);
    expect(h.provider.callsTo("transitionLabel")).toHaveLength(0);

    const updated = await h.readProjects();
    expect(updated.projects[h.project.slug]!.issueRuntime?.["42"]?.firstWorkerActivityAt).toBeTruthy();

    const events = await readAuditEvents(h.workspaceDir);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "first_worker_activity",
          source: "heartbeat_session_activity",
        }),
      ]),
    );
  });

  it("repairs a terminal developer session when the transcript contains a canonical final result", async () => {
    h = await createTestHarness({
      workers: {
        developer: {
          active: true,
          issueId: "42",
          sessionKey: "agent:main:subagent:test-project-developer-senior-cecily",
          level: "senior",
          startTime: new Date(Date.now() - 20 * 60_000).toISOString(),
          previousLabel: "To Do",
        },
      },
    });
    h.provider.seedIssue({ iid: 42, title: "Recover terminal developer completion", labels: ["Doing"] });
    h.provider.setPrStatus(42, {
      state: "open",
      url: "https://example.com/pr/42",
      body: VALID_DEVELOPER_QA_EVIDENCE,
      linkedIssueIds: [42],
      currentIssueMatch: true,
    });

    const transcriptPath = path.join(h.workspaceDir, "session-42.jsonl");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "Work result: DONE" }],
      })}\n`,
      "utf-8",
    );

    const data = await h.readProjects();
    data.projects[h.project.slug]!.issueRuntime = {
      "42": {
        dispatchRequestedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        agentAcceptedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        lastSessionKey: "agent:main:subagent:test-project-developer-senior-cecily",
        firstWorkerActivityAt: new Date(Date.now() - 9 * 60_000).toISOString(),
        sessionCompletedAt: null,
      },
    };
    await writeProjects(h.workspaceDir, data);

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-cecily",
        {
          key: "agent:main:subagent:test-project-developer-senior-cecily",
          updatedAt: Date.now() - 60_000,
          percentUsed: 15,
          status: "done",
          endedAt: Date.now() - 30_000,
          sessionFile: transcriptPath,
          sessionFileMtime: Date.now() - 1_000,
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
      runCommand: h.runCommand,
    });

    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.fixed).toBe(true);

    const issue = await h.provider.getIssue(42);
    expect(issue.labels).toContain("To Review");
    expect(issue.labels).not.toContain("Doing");
    expect(h.provider.callsTo("transitionLabel")).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          args: expect.objectContaining({ from: "Doing", to: "To Do" }),
        }),
      ]),
    );

    const updated = await h.readProjects();
    const slot = updated.projects[h.project.slug]!.workers.developer.levels.senior?.[0];
    const runtime = updated.projects[h.project.slug]!.issueRuntime?.["42"];
    expect(slot?.active).toBe(false);
    expect(slot?.issueId).toBeNull();
    expect(runtime?.sessionCompletedAt).toBeTruthy();

    const events = await readAuditEvents(h.workspaceDir);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "worker_completion_applied",
          issueId: 42,
          role: "developer",
          result: "DONE",
          source: "session_history",
        }),
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "health_fix_applied",
          type: "session_dead",
          issueId: "42",
        }),
      ]),
    );
  });

  it("does not advance a healthy live session just because the transcript already contains a canonical final result", async () => {
    h = await createTestHarness({
      workers: {
        developer: {
          active: true,
          issueId: "42",
          sessionKey: "agent:main:subagent:test-project-developer-senior-cecily",
          level: "senior",
          startTime: new Date(Date.now() - 20 * 60_000).toISOString(),
          previousLabel: "To Do",
        },
      },
    });
    h.provider.seedIssue({ iid: 42, title: "Keep live developer session active", labels: ["Doing"] });
    h.provider.setPrStatus(42, {
      state: "open",
      url: "https://example.com/pr/42",
      body: VALID_DEVELOPER_QA_EVIDENCE,
      linkedIssueIds: [42],
      currentIssueMatch: true,
    });

    const transcriptPath = path.join(h.workspaceDir, "session-live-42.jsonl");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "Work result: DONE" }],
      })}\n`,
      "utf-8",
    );

    const data = await h.readProjects();
    data.projects[h.project.slug]!.issueRuntime = {
      "42": {
        dispatchRequestedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        agentAcceptedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        lastSessionKey: "agent:main:subagent:test-project-developer-senior-cecily",
        firstWorkerActivityAt: new Date(Date.now() - 9 * 60_000).toISOString(),
        sessionCompletedAt: null,
      },
    };
    await writeProjects(h.workspaceDir, data);

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-cecily",
        {
          key: "agent:main:subagent:test-project-developer-senior-cecily",
          updatedAt: Date.now() - 15_000,
          percentUsed: 15,
          status: "running",
          sessionFile: transcriptPath,
          sessionFileMtime: Date.now() - 1_000,
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
      runCommand: h.runCommand,
    });

    expect(fixes).toHaveLength(0);
    expect(h.provider.callsTo("transitionLabel")).toHaveLength(0);

    const updated = await h.readProjects();
    const slot = updated.projects[h.project.slug]!.workers.developer.levels.senior?.[0];
    expect(slot?.active).toBe(true);
    expect(slot?.issueId).toBe("42");
    expect(updated.projects[h.project.slug]!.issueRuntime?.["42"]?.sessionCompletedAt).toBeNull();
  });

  it("does not repair from a stale terminal transcript after the session key was reused for a newer dispatch", async () => {
    h = await createTestHarness({
      workers: {
        developer: {
          active: true,
          issueId: "42",
          sessionKey: "agent:main:subagent:test-project-developer-senior-cecily",
          level: "senior",
          startTime: new Date(Date.now() - 60_000).toISOString(),
          previousLabel: "To Do",
        },
      },
    });
    h.provider.seedIssue({ iid: 42, title: "Ignore stale terminal transcript", labels: ["Doing"] });
    h.provider.setPrStatus(42, {
      state: "open",
      url: "https://example.com/pr/42",
      body: VALID_DEVELOPER_QA_EVIDENCE,
      linkedIssueIds: [42],
      currentIssueMatch: true,
    });

    const dispatchRequestedAt = Date.now() - 30_000;
    const terminalEndedAt = dispatchRequestedAt - 20_000;
    const transcriptPath = path.join(h.workspaceDir, "session-stale-42.jsonl");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "Work result: DONE" }],
      })}\n`,
      "utf-8",
    );
    await fs.utimes(transcriptPath, terminalEndedAt / 1000, terminalEndedAt / 1000);

    const data = await h.readProjects();
    data.projects[h.project.slug]!.issueRuntime = {
      "42": {
        dispatchRequestedAt: new Date(dispatchRequestedAt).toISOString(),
        agentAcceptedAt: new Date(dispatchRequestedAt + 5_000).toISOString(),
        lastSessionKey: "agent:main:subagent:test-project-developer-senior-cecily",
        firstWorkerActivityAt: null,
        sessionCompletedAt: null,
      },
    };
    await writeProjects(h.workspaceDir, data);

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-cecily",
        {
          key: "agent:main:subagent:test-project-developer-senior-cecily",
          updatedAt: terminalEndedAt,
          percentUsed: 15,
          status: "done",
          endedAt: terminalEndedAt,
          sessionFile: transcriptPath,
          sessionFileMtime: terminalEndedAt,
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
      runCommand: h.runCommand,
      healthGracePeriodMs: 5 * 60_000,
    });

    expect(fixes).toHaveLength(0);
    expect(h.provider.callsTo("transitionLabel")).toHaveLength(0);

    const updated = await h.readProjects();
    const slot = updated.projects[h.project.slug]!.workers.developer.levels.senior?.[0];
    expect(slot?.active).toBe(true);
    expect(slot?.issueId).toBe("42");
    expect(updated.projects[h.project.slug]!.issueRuntime?.["42"]?.sessionCompletedAt).toBeNull();

    const events = await readAuditEvents(h.workspaceDir);
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "worker_completion_applied",
          issueId: 42,
          role: "developer",
        }),
      ]),
    );
  });

  it("requeues an active issue when the session record exists but is already terminal", async () => {
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
    h.provider.seedIssue({ iid: 42, title: "Recover completed session", labels: ["Doing"] });

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: Date.now() - 60_000,
          percentUsed: 15,
          status: "done",
          endedAt: Date.now() - 30_000,
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
    });

    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.issue.type).toBe("session_dead");
    expect(fixes[0]?.fixed).toBe(true);

    const issue = await h.provider.getIssue(42);
    expect(issue.labels).toContain("To Improve");
    expect(issue.labels).not.toContain("Doing");

    const data = await h.readProjects();
    const slot = data.projects[h.project.slug]!.workers.developer.levels.senior?.[0];
    expect(slot?.active).toBe(false);
    expect(slot?.issueId).toBeNull();
  });

  it("respects healthGracePeriodMs when deciding whether a missing session is dead", async () => {
    h = await createTestHarness({
      workers: {
        developer: {
          active: true,
          issueId: "42",
          sessionKey: "agent:main:subagent:test-project-developer-senior-ada",
          level: "senior",
          startTime: new Date(Date.now() - 90_000).toISOString(),
          previousLabel: "To Do",
        },
      },
    });
    h.provider.seedIssue({ iid: 42, title: "Recent dispatch", labels: ["Doing"] });

    const fixes = await checkWorkerHealth({
      workspaceDir: h.workspaceDir,
      projectSlug: h.project.slug,
      project: h.project,
      role: "developer",
      autoFix: true,
      provider: h.provider,
      sessions: new Map(),
      staleWorkerHours: 999,
      healthGracePeriodMs: 120_000,
    });

    expect(fixes).toHaveLength(0);
    expect(h.provider.callsTo("transitionLabel")).toHaveLength(0);
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

    const dispatchedAt = Date.now() - 10 * 60_000;
    const data = await h.readProjects();
    data.projects[h.project.slug]!.issueRuntime = {
      "42": {
        dispatchRequestedAt: new Date(dispatchedAt).toISOString(),
        lastSessionKey: "agent:main:subagent:test-project-developer-senior-ada",
      },
    };
    await writeProjects(h.workspaceDir, data);

    const sessions: SessionLookup = new Map([
      [
        "agent:main:subagent:test-project-developer-senior-ada",
        {
          key: "agent:main:subagent:test-project-developer-senior-ada",
          updatedAt: dispatchedAt,
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

describe("performHealthPass — notification outbox retry", () => {
  it("keeps an outbox entry pending when notify() returns false", async () => {
    const { performHealthPass } = await import("../../lib/services/heartbeat/passes.js");
    const notifyModule = await import("../../lib/dispatch/notify.js");
    const notifySpy = vi.spyOn(notifyModule, "notify").mockResolvedValue(false as never);

    const harness = await createTestHarness({
      workers: {},
    });

    try {
      await writeIntent(
        harness.workspaceDir,
        "pending-notify-key",
        {
          type: "reviewNeeded",
          project: harness.project.name,
          issueId: 42,
          issueUrl: "https://example.com/issues/42",
          issueTitle: "Retry me",
          routing: "human",
        },
        {
          channelId: "project-channel",
          channel: "telegram",
        },
      );

      const outboxPath = path.join(harness.workspaceDir, DATA_DIR, "notifications-outbox.ndjson");
      const raw = await fs.readFile(outboxPath, "utf-8");
      const updated = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const entry = JSON.parse(line) as { key: string; ts: number };
          if (entry.key !== "pending-notify-key") return line;
          return JSON.stringify({ ...entry, ts: Date.now() - 5 * 60_000 });
        })
        .join("\n");
      await fs.writeFile(outboxPath, `${updated}\n`, "utf-8");

      const before = await getPendingIntents(harness.workspaceDir);
      expect(before).toHaveLength(1);

      const healthModule = await import("../../lib/services/heartbeat/health.js");
      vi.spyOn(healthModule, "checkWorkerHealth").mockResolvedValue([]);
      vi.spyOn(healthModule, "scanOrphanedLabels").mockResolvedValue([]);
      vi.spyOn(healthModule, "scanStatelessIssues").mockResolvedValue([]);

      await performHealthPass(
        harness.workspaceDir,
        harness.project.slug,
        { workers: {}, channels: [], slug: harness.project.slug, name: harness.project.name } as any,
        null,
        harness.provider as any,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          timeouts: { dispatchConfirmTimeoutMs: 5000, staleWorkerHours: 2, stallTimeoutMinutes: 10 },
          workflow: harness.workflow as any,
        } as any,
      );

      expect(notifySpy).toHaveBeenCalledTimes(1);
      const after = await getPendingIntents(harness.workspaceDir);
      expect(after).toHaveLength(1);
    } finally {
      notifySpy.mockRestore();
      await harness.cleanup();
    }
  });

  it("retries a stale notification without creating a fresh outbox row", async () => {
    const { performHealthPass } = await import("../../lib/services/heartbeat/passes.js");

    const harness = await createTestHarness({
      workers: {},
    });

    try {
      await writeIntent(
        harness.workspaceDir,
        "pending-notify-success-key",
        {
          type: "reviewNeeded",
          project: harness.project.name,
          issueId: 43,
          issueUrl: "https://example.com/issues/43",
          issueTitle: "Retry cleanly",
          routing: "human",
        },
        {
          channelId: "project-channel",
          channel: "telegram",
        },
      );

      const outboxPath = path.join(harness.workspaceDir, DATA_DIR, "notifications-outbox.ndjson");
      const raw = await fs.readFile(outboxPath, "utf-8");
      const updated = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const entry = JSON.parse(line) as { key: string; ts: number };
          if (entry.key !== "pending-notify-success-key") return line;
          return JSON.stringify({ ...entry, ts: Date.now() - 5 * 60_000 });
        })
        .join("\n");
      await fs.writeFile(outboxPath, `${updated}\n`, "utf-8");

      const healthModule = await import("../../lib/services/heartbeat/health.js");
      vi.spyOn(healthModule, "checkWorkerHealth").mockResolvedValue([]);
      vi.spyOn(healthModule, "scanOrphanedLabels").mockResolvedValue([]);
      vi.spyOn(healthModule, "scanStatelessIssues").mockResolvedValue([]);

      await performHealthPass(
        harness.workspaceDir,
        harness.project.slug,
        { workers: {}, channels: [], slug: harness.project.slug, name: harness.project.name } as any,
        null,
        harness.provider as any,
        undefined,
        undefined,
        harness.runCommand,
        undefined,
        undefined,
        {
          timeouts: { dispatchConfirmTimeoutMs: 5000, staleWorkerHours: 2, stallTimeoutMinutes: 10 },
          workflow: harness.workflow as any,
        } as any,
      );

      expect(await getPendingIntents(harness.workspaceDir)).toHaveLength(0);
      const after = (await fs.readFile(outboxPath, "utf-8")).split("\n").filter(Boolean);
      expect(after).toHaveLength(1);
      expect(JSON.parse(after[0]!).status).toBe("delivered");
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps the stale intent pending when notifications are disabled", async () => {
    const { performHealthPass } = await import("../../lib/services/heartbeat/passes.js");

    const harness = await createTestHarness({
      workers: {},
    });

    try {
      await writeIntent(
        harness.workspaceDir,
        "pending-notify-disabled-key",
        {
          type: "reviewNeeded",
          project: harness.project.name,
          issueId: 44,
          issueUrl: "https://example.com/issues/44",
          issueTitle: "Do not clear on skip",
          routing: "human",
        },
        {
          channelId: "project-channel",
          channel: "telegram",
        },
      );

      const outboxPath = path.join(harness.workspaceDir, DATA_DIR, "notifications-outbox.ndjson");
      const raw = await fs.readFile(outboxPath, "utf-8");
      const updated = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const entry = JSON.parse(line) as { key: string; ts: number };
          if (entry.key !== "pending-notify-disabled-key") return line;
          return JSON.stringify({ ...entry, ts: Date.now() - 5 * 60_000 });
        })
        .join("\n");
      await fs.writeFile(outboxPath, `${updated}\n`, "utf-8");

      const healthModule = await import("../../lib/services/heartbeat/health.js");
      vi.spyOn(healthModule, "checkWorkerHealth").mockResolvedValue([]);
      vi.spyOn(healthModule, "scanOrphanedLabels").mockResolvedValue([]);
      vi.spyOn(healthModule, "scanStatelessIssues").mockResolvedValue([]);

      await performHealthPass(
        harness.workspaceDir,
        harness.project.slug,
        { workers: {}, channels: [], slug: harness.project.slug, name: harness.project.name } as any,
        null,
        harness.provider as any,
        undefined,
        undefined,
        harness.runCommand,
        undefined,
        undefined,
        {
          notifications: { reviewNeeded: false },
          timeouts: { dispatchConfirmTimeoutMs: 5000, staleWorkerHours: 2, stallTimeoutMinutes: 10 },
          workflow: harness.workflow as any,
        } as any,
      );

      const pending = await getPendingIntents(harness.workspaceDir);
      expect(pending.map((entry) => entry.key)).toContain("pending-notify-disabled-key");
    } finally {
      await harness.cleanup();
    }
  });
});
