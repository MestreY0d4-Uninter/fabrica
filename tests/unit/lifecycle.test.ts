import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordIssueLifecycle, recordIssueLifecycleBySessionKey } from "../../lib/projects/lifecycle.js";
import { createTestHarness, type TestHarness } from "../../lib/testing/index.js";
import { DATA_DIR } from "../../lib/setup/migrate-layout.js";

async function readAuditEvents(workspaceDir: string): Promise<Array<Record<string, unknown>>> {
  const filePath = path.join(workspaceDir, DATA_DIR, "log", "audit.log");
  const content = await fs.readFile(filePath, "utf-8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("issue lifecycle recording", () => {
  let harness: TestHarness | null = null;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = null;
  });

  it("persists explicit lifecycle timestamps and exact audit events", async () => {
    const sessionKey = "agent:main:subagent:test-project-developer-senior-ada";
    harness = await createTestHarness({
      workers: {
        developer: {
          active: true,
          issueId: "42",
          sessionKey,
          level: "senior",
          startTime: new Date().toISOString(),
        },
      },
    });

    await recordIssueLifecycle({
      workspaceDir: harness.workspaceDir,
      slug: harness.project.slug,
      issueId: 42,
      stage: "dispatch_requested",
      sessionKey,
      details: { role: "developer" },
    });
    await recordIssueLifecycleBySessionKey({
      workspaceDir: harness.workspaceDir,
      sessionKey,
      stage: "session_patched",
    });
    await recordIssueLifecycleBySessionKey({
      workspaceDir: harness.workspaceDir,
      sessionKey,
      stage: "agent_accepted",
    });
    const firstActivity = await recordIssueLifecycleBySessionKey({
      workspaceDir: harness.workspaceDir,
      sessionKey,
      stage: "first_worker_activity",
      details: { source: "test" },
    });
    const duplicateFirstActivity = await recordIssueLifecycleBySessionKey({
      workspaceDir: harness.workspaceDir,
      sessionKey,
      stage: "first_worker_activity",
      details: { source: "test" },
    });
    await recordIssueLifecycle({
      workspaceDir: harness.workspaceDir,
      slug: harness.project.slug,
      issueId: 42,
      stage: "session_completed",
      sessionKey,
    });

    expect(firstActivity).toBe(true);
    expect(duplicateFirstActivity).toBe(false);

    const data = await harness.readProjects();
    const runtime = data.projects[harness.project.slug]?.issueRuntime?.["42"];
    expect(runtime?.lastSessionKey).toBe(sessionKey);
    expect(runtime?.dispatchRequestedAt).toBeTruthy();
    expect(runtime?.sessionPatchedAt).toBeTruthy();
    expect(runtime?.agentAcceptedAt).toBeTruthy();
    expect(runtime?.firstWorkerActivityAt).toBeTruthy();
    expect(runtime?.sessionCompletedAt).toBeTruthy();

    const events = await readAuditEvents(harness.workspaceDir);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "dispatch_requested", issueId: 42, sessionKey }),
        expect.objectContaining({ event: "session_patched", issueId: 42, sessionKey }),
        expect.objectContaining({ event: "agent_accepted", issueId: 42, sessionKey }),
        expect.objectContaining({ event: "first_worker_activity", issueId: 42, sessionKey }),
        expect.objectContaining({ event: "session_completed", issueId: 42, sessionKey }),
      ]),
    );
  });

  it("does not erase later lifecycle milestones when dispatch is recorded again", async () => {
    const sessionKey = "agent:main:subagent:test-project-developer-senior-ada";
    harness = await createTestHarness({
      workers: {
        developer: {
          active: true,
          issueId: "42",
          sessionKey,
          level: "senior",
          startTime: new Date().toISOString(),
        },
      },
    });

    await recordIssueLifecycle({
      workspaceDir: harness.workspaceDir,
      slug: harness.project.slug,
      issueId: 42,
      stage: "dispatch_requested",
      sessionKey,
    });
    await recordIssueLifecycle({
      workspaceDir: harness.workspaceDir,
      slug: harness.project.slug,
      issueId: 42,
      stage: "session_completed",
      sessionKey,
    });
    const before = (await harness.readProjects()).projects[harness.project.slug]?.issueRuntime?.["42"]?.sessionCompletedAt;

    await recordIssueLifecycle({
      workspaceDir: harness.workspaceDir,
      slug: harness.project.slug,
      issueId: 42,
      stage: "dispatch_requested",
      sessionKey: "agent:main:subagent:test-project-developer-senior-grace",
    });

    const runtime = (await harness.readProjects()).projects[harness.project.slug]?.issueRuntime?.["42"];
    expect(runtime?.sessionCompletedAt).toBe(before);
    expect(runtime?.dispatchRequestedAt).toBeTruthy();
  });
});
