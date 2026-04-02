# Hot-Path Event Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Telegram topic timeline faithful to the real Fabrica hot path by adding reviewer outcome notifications, making notification dedupe cycle-aware, and recovering developer cycles that are no longer provably alive.

**Architecture:** The implementation keeps one message per operational event, but moves each message behind a single authority point and a cycle-aware notification identity. Reviewer outcomes become first-class notify events with short rationale extraction, pipeline notifications carry dispatch identity so late deliveries do not masquerade as current work, and the health/recovery slice stops trusting stuck developer slots whose live session can no longer be proven.

**Tech Stack:** TypeScript, Vitest, OpenClaw plugin runtime/hooks, Fabrica notification outbox, reviewer lifecycle parsing, Telegram topic delivery, GitHub provider/PR checks

---

## File Structure

- Modify: `lib/services/reviewer-session.ts`
  - Add a conservative helper that extracts a short reviewer rationale from the final assistant message that contains `Review result:`.
- Modify: `lib/services/reviewer-completion.ts`
  - Emit `reviewRejected` / `reviewApproved` notifications at the same authority point that applies the review transition.
- Modify: `lib/dispatch/notify.ts`
  - Add event types and message builders for reviewer outcome events.
- Modify: `lib/dispatch/notification-outbox.ts`
  - Replace minute-bucket dedupe with cycle-aware event identity.
- Modify: `lib/services/pipeline.ts`
  - Pass dispatch identity into `workerComplete` / `reviewNeeded` events so delivery and dedupe are tied to a specific cycle.
- Modify: `lib/services/gateway-sessions.ts`
  - Add a liveness helper that can reject a session whose registry entry points to a missing session file.
- Modify: `lib/services/heartbeat/health.ts`
  - Apply safe recovery when a developer slot is active but no live session can be proven.
- Test: `tests/unit/reviewer-session.test.ts`
- Test: `tests/unit/reviewer-completion.test.ts`
- Test: `tests/unit/notify.test.ts`
- Test: `tests/unit/notification-outbox.test.ts`
- Test: `tests/unit/pipeline-notify.test.ts`
- Test: `tests/unit/heartbeat-health-session.test.ts`

### Task 1: Freeze Reviewer Outcome Visibility Regressions

**Files:**
- Modify: `tests/unit/reviewer-session.test.ts`
- Modify: `tests/unit/reviewer-completion.test.ts`
- Modify: `tests/unit/notify.test.ts`

- [ ] **Step 1: Add a failing reviewer rationale extraction test**

```ts
it("extracts a short reject rationale from the final reviewer message", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "I can’t approve this as-is.",
            "",
            "### Blocking findings",
            "",
            "1. Correctness bug: prefix detection is too permissive",
            "2. Tests do not fully cover the acceptance criteria",
            "",
            "Review result: REJECT",
          ].join("\n"),
        },
      ],
    },
  ];

  expect(extractReviewerRationaleFromMessages(messages)).toBe(
    "Correctness bug: prefix detection is too permissive; tests do not fully cover the acceptance criteria",
  );
});
```

- [ ] **Step 2: Run the reviewer-session test and verify it fails**

Run: `cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica && npx vitest run tests/unit/reviewer-session.test.ts -t "extracts a short reject rationale from the final reviewer message"`

Expected: FAIL because `extractReviewerRationaleFromMessages` does not exist yet.

- [ ] **Step 3: Add a failing reviewer completion notification test**

```ts
it("notifies the project topic when an agent reviewer rejects", async () => {
  notifyMock.mockResolvedValue(undefined);

  await handleReviewerAgentEnd({
    sessionKey: "agent:main:subagent:todo-summary-reviewer-junior-susy",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Blocking findings\n\nReview result: REJECT" },
        ],
      },
    ],
    workspaceDir,
    runCommand,
  });

  expect(notifyMock).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "reviewRejected",
      project: "todo-summary",
      issueId: 1,
      summary: expect.stringContaining("Blocking findings"),
    }),
    expect.any(Object),
  );
});
```

- [ ] **Step 4: Run the reviewer completion test and verify it fails**

Run: `cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica && npx vitest run tests/unit/reviewer-completion.test.ts -t "notifies the project topic when an agent reviewer rejects"`

Expected: FAIL because `handleReviewerAgentEnd(...)` currently transitions and audits, but does not call `notify(...)`.

- [ ] **Step 5: Add a failing notify message-shape test**

```ts
it("formats a reviewRejected notification with a short rationale", () => {
  const message = buildMessage({
    type: "reviewRejected",
    project: "todo-summary",
    issueId: 1,
    issueUrl: "https://github.com/MestreY0d4-Uninter/todo-summary/issues/1",
    issueTitle: "todo-summary-cli",
    prUrl: "https://github.com/MestreY0d4-Uninter/todo-summary/pull/2",
    summary: "Correctness bug in prefix detection",
  });

  expect(message).toContain("Review rejected");
  expect(message).toContain("Correctness bug in prefix detection");
  expect(message).toContain("Pull Request #2");
});
```

- [ ] **Step 6: Run the notify test and verify it fails**

Run: `cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica && npx vitest run tests/unit/notify.test.ts -t "formats a reviewRejected notification with a short rationale"`

Expected: FAIL because `reviewRejected` is not a supported notify event yet.

- [ ] **Step 7: Commit the failing-test checkpoint**

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
git add tests/unit/reviewer-session.test.ts tests/unit/reviewer-completion.test.ts tests/unit/notify.test.ts
git commit -m "test(timeline): freeze reviewer outcome notifications"
```

### Task 2: Implement Reviewer Outcome Notifications

**Files:**
- Modify: `lib/services/reviewer-session.ts`
- Modify: `lib/services/reviewer-completion.ts`
- Modify: `lib/dispatch/notify.ts`
- Test: `tests/unit/reviewer-session.test.ts`
- Test: `tests/unit/reviewer-completion.test.ts`
- Test: `tests/unit/notify.test.ts`

- [ ] **Step 1: Add a conservative rationale extractor next to the decision parser**

```ts
export function extractReviewerRationaleFromMessages(messages: unknown[]): string | null {
  const assistantTexts = messages
    .filter((message): message is ReviewerMessage => typeof message === "object" && message != null)
    .filter((message) => message.role === "assistant")
    .map((message) => extractTextContent(message.content))
    .filter(Boolean)
    .reverse();

  for (const text of assistantTexts) {
    if (!/^\s*Review result:\s*REJECT\s*$/gim.test(text)) continue;
    const findings = Array.from(text.matchAll(/^\s*\d+\.\s+(.+)$/gm)).map((match) => match[1]?.trim()).filter(Boolean);
    if (findings.length > 0) return findings.slice(0, 2).join("; ");
    const blocking = text.match(/^\s*###\s*Blocking findings\s*([\s\S]*?)^\s*Review result:/im);
    return blocking?.[1]?.trim().split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 2).join(" ") || null;
  }

  return null;
}
```

- [ ] **Step 2: Add notify event shapes for reviewer outcomes**

```ts
  | {
      type: "reviewRejected";
      project: string;
      issueId: number;
      issueUrl: string;
      issueTitle: string;
      prUrl?: string;
      summary?: string;
    }
  | {
      type: "reviewApproved";
      project: string;
      issueId: number;
      issueUrl: string;
      issueTitle: string;
      prUrl?: string;
    };
```

- [ ] **Step 3: Add concise message builders for the new events**

```ts
    case "reviewRejected": {
      let msg = `❌ Review rejected for #${event.issueId}: ${event.issueTitle}`;
      if (event.summary) msg += `\n${event.summary}`;
      if (event.prUrl) msg += `\n🔗 ${prLink(event.prUrl)}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
      msg += `\n→ Moving to To Improve for developer re-dispatch`;
      return msg;
    }

    case "reviewApproved": {
      let msg = `✅ Review approved for #${event.issueId}: ${event.issueTitle}`;
      if (event.prUrl) msg += `\n🔗 ${prLink(event.prUrl)}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
      msg += `\n→ Moving to testing or merge flow`;
      return msg;
    }
```

- [ ] **Step 4: Emit the reviewer outcome notification from the same authority point that applies the transition**

```ts
const summary = decision === "reject" && Array.isArray(opts.messages)
  ? extractReviewerRationaleFromMessages(opts.messages)
  : null;

await notify(
  {
    type: decision === "reject" ? "reviewRejected" : "reviewApproved",
    project: context.project.name,
    issueId: context.issueId,
    issueUrl: issue.web_url,
    issueTitle: issue.title,
    prUrl: context.issueRuntime?.currentPrUrl ?? undefined,
    summary: summary ?? undefined,
  } as const,
  {
    workspaceDir: opts.workspaceDir,
    config: getNotificationConfig((await loadConfig(opts.workspaceDir, context.projectSlug)).pluginConfig),
    channelId: context.project.channels[0]?.channelId,
    channel: context.project.channels[0]?.channel ?? "telegram",
    runtime: undefined,
    runCommand: opts.runCommand,
    accountId: context.project.channels[0]?.accountId,
    messageThreadId: context.project.channels[0]?.messageThreadId,
  },
);
```

- [ ] **Step 5: Re-run the reviewer notification tests and make them pass**

Run: `cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica && npx vitest run tests/unit/reviewer-session.test.ts tests/unit/reviewer-completion.test.ts tests/unit/notify.test.ts`

Expected: PASS for the new rationale extraction and reviewer outcome notification coverage.

- [ ] **Step 6: Commit the reviewer notification slice**

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
git add lib/services/reviewer-session.ts lib/services/reviewer-completion.ts lib/dispatch/notify.ts tests/unit/reviewer-session.test.ts tests/unit/reviewer-completion.test.ts tests/unit/notify.test.ts
git commit -m "feat(timeline): notify reviewer outcomes"
```

### Task 3: Make Notification Identity Cycle-Aware

**Files:**
- Modify: `lib/dispatch/notification-outbox.ts`
- Modify: `lib/services/pipeline.ts`
- Test: `tests/unit/notification-outbox.test.ts`
- Test: `tests/unit/pipeline-notify.test.ts`

- [ ] **Step 1: Add a failing outbox dedupe test for two different cycles**

```ts
it("allows the same event type across different dispatch cycles", async () => {
  const first = computeNotifyKey("todo-summary", 1, "workerComplete", {
    dispatchCycleId: "cycle-a",
    result: "DONE",
  });
  const second = computeNotifyKey("todo-summary", 1, "workerComplete", {
    dispatchCycleId: "cycle-b",
    result: "DONE",
  });

  expect(first).not.toBe(second);
});
```

- [ ] **Step 2: Add a failing pipeline test that requires dispatch identity in notify payload**

```ts
expect(notifyMock).toHaveBeenCalledWith(
  expect.objectContaining({
    type: "workerComplete",
    dispatchCycleId: "cycle-a",
    dispatchRunId: "run-a",
  }),
  expect.any(Object),
);
```

- [ ] **Step 3: Run the outbox and pipeline tests and verify they fail**

Run: `cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica && npx vitest run tests/unit/notification-outbox.test.ts tests/unit/pipeline-notify.test.ts`

Expected: FAIL because outbox keys are still minute-bucket based and pipeline events do not carry cycle identity.

- [ ] **Step 4: Replace the old notify key contract with explicit cycle metadata**

```ts
export function computeNotifyKey(
  projectSlug: string,
  issueId: number,
  eventType: string,
  identity: {
    dispatchCycleId?: string | null;
    dispatchRunId?: string | null;
    result?: string | null;
  },
): string {
  const input = JSON.stringify({
    projectSlug,
    issueId,
    eventType,
    dispatchCycleId: identity.dispatchCycleId ?? null,
    dispatchRunId: identity.dispatchRunId ?? null,
    result: identity.result ?? null,
  });
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
```

- [ ] **Step 5: Thread dispatch identity through pipeline notifications**

```ts
notify(
  {
    type: "workerComplete",
    project: projectName,
    issueId,
    issueUrl: issue.web_url,
    role,
    level: opts.level,
    name: workerName,
    result: effectiveResult as "done" | "pass" | "fail" | "refine" | "blocked",
    summary: effectiveSummary,
    nextState,
    prUrl,
    createdTasks,
    dispatchCycleId: issueRuntime?.lastDispatchCycleId ?? null,
    dispatchRunId: issueRuntime?.dispatchRunId ?? null,
  },
  { ... }
);
```

- [ ] **Step 6: Re-run the notification identity tests and make them pass**

Run: `cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica && npx vitest run tests/unit/notification-outbox.test.ts tests/unit/pipeline-notify.test.ts`

Expected: PASS, proving same-type events can coexist across cycles while still deduping within one exact cycle.

- [ ] **Step 7: Commit the cycle-aware outbox slice**

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
git add lib/dispatch/notification-outbox.ts lib/services/pipeline.ts tests/unit/notification-outbox.test.ts tests/unit/pipeline-notify.test.ts
git commit -m "fix(timeline): make notification dedupe cycle-aware"
```

### Task 4: Recover Stuck Developer Cycles That Are No Longer Provably Alive

**Files:**
- Modify: `lib/services/gateway-sessions.ts`
- Modify: `lib/services/heartbeat/health.ts`
- Test: `tests/unit/heartbeat-health-session.test.ts`

- [ ] **Step 1: Add a failing health test for a slot whose registered session file does not exist**

```ts
it("requeues an active developer slot when its registered session file is missing", async () => {
  gatewaySessionsMock.mockResolvedValue(new Map([
    ["agent:main:subagent:todo-summary-developer-medior-brittne", {
      key: "agent:main:subagent:todo-summary-developer-medior-brittne",
      updatedAt: Date.now(),
      percentUsed: 0,
    }],
  ]));

  sessionsRegistryMock.mockReturnValue({
    sessionFile: "/missing/session.jsonl",
    updatedAt: Date.now(),
  });

  await runHeartbeatHealthPass({ workspaceDir, runCommand, runtime: undefined } as any);

  expect(provider.transitionLabel).toHaveBeenCalledWith(1, "Doing", "To Improve");
});
```

- [ ] **Step 2: Run the health test and verify it fails**

Run: `cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica && npx vitest run tests/unit/heartbeat-health-session.test.ts -t "requeues an active developer slot when its registered session file is missing"`

Expected: FAIL because current liveness only trusts session-key presence and terminal metadata, not missing session artifacts.

- [ ] **Step 3: Add a helper that refuses to treat a missing session artifact as proven live**

```ts
export async function canProveSessionAlive(
  sessionKey: string,
  sessions: SessionLookup | null,
  readRegistryEntry?: (sessionKey: string) => Promise<{ sessionFile?: string | null } | null>,
): Promise<boolean> {
  if (!isSessionAlive(sessionKey, sessions)) return false;
  const registry = await readRegistryEntry?.(sessionKey);
  if (!registry?.sessionFile) return true;
  try {
    await fs.access(registry.sessionFile);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Use the stronger liveness check in the heartbeat health path**

```ts
const alive = await canProveSessionAlive(slot.sessionKey, sessions, readGatewaySessionRegistryEntry);
if (!alive) {
  await provider.transitionLabel(issueId, activeLabel, revertLabel);
  await deactivateWorker(workspaceDir, project.slug, "developer", {
    level,
    slotIndex,
    issueId: String(issueId),
  });
  await auditLog(workspaceDir, "health_fix_applied", {
    project: project.slug,
    issue: issueId,
    reason: "session_not_provably_alive",
  }).catch(() => {});
}
```

- [ ] **Step 5: Re-run the health test suite and make the recovery case pass**

Run: `cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica && npx vitest run tests/unit/heartbeat-health-session.test.ts`

Expected: PASS, proving the health pass no longer leaves a developer slot indefinitely in `Doing` when live session evidence is gone.

- [ ] **Step 6: Commit the stuck-cycle recovery slice**

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
git add lib/services/gateway-sessions.ts lib/services/heartbeat/health.ts tests/unit/heartbeat-health-session.test.ts
git commit -m "fix(health): recover stale developer cycles"
```

### Task 5: Validate the Timeline End-to-End

**Files:**
- Modify if needed: `tests/e2e/orchestration-smoke.e2e.test.ts`
- Verify live state in `/home/mateus/.openclaw/workspace/fabrica`

- [ ] **Step 1: Add or extend an integration test for reviewer reject timeline ordering**

```ts
it("emits developer complete, review queued, reviewer start, and review rejected in cycle order", async () => {
  const timeline = await runHotPathScenario("reject");

  expect(timeline).toEqual([
    "workerStart:developer",
    "workerComplete:developer",
    "reviewQueued",
    "workerStart:reviewer",
    "reviewRejected",
    "workerStart:developer",
  ]);
});
```

- [ ] **Step 2: Run the focused automated verification**

Run: `cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica && npx vitest run tests/unit/reviewer-session.test.ts tests/unit/reviewer-completion.test.ts tests/unit/notify.test.ts tests/unit/notification-outbox.test.ts tests/unit/pipeline-notify.test.ts tests/unit/heartbeat-health-session.test.ts`

Expected: PASS with the new timeline and recovery coverage green.

- [ ] **Step 3: Run build and hot-path verification**

Run: `cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica && npm run build && npm run test:hot-path`

Expected: build succeeds and hot-path suite stays green.

- [ ] **Step 4: Validate against the real Telegram flow**

Run:

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
openclaw fabrica status -w /home/mateus/.openclaw/workspace
gh pr checks 2 --repo MestreY0d4-Uninter/todo-summary
```

Expected live behavior:
- the topic shows `developer start`
- then `developer complete`
- then `review queued`
- then `reviewer start`
- then `review rejected` with short reason
- then a new `developer start`
- no stale prior-cycle `workerComplete` appears after the reject event

- [ ] **Step 5: Commit the validation or final cleanup only if code changed**

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
git status --short
```

Expected: no unexpected files left behind. If tests required fixture changes, commit them with a focused message such as:

```bash
git add tests/e2e/orchestration-smoke.e2e.test.ts
git commit -m "test(timeline): cover reviewer reject ordering"
```
