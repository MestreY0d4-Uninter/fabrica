# Hot Path Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the Fabrica hot path so a valid Telegram DM reliably becomes a recoverable bootstrap flow, durable project registration, and deterministic downstream execution without changing OpenClaw or adding new product scope.

**Architecture:** The implementation hardens the existing flow instead of replacing it. Bootstrap becomes a single durable step runner with explicit checkpoint persistence and ownership, register/provision stops leaking silent split-brain state, recovery reuses the same bootstrap executor, and downstream review/test plus CLI observability are revalidated and tightened where needed.

**Tech Stack:** TypeScript, Vitest, OpenClaw plugin runtime/hooks, Telegram DM bootstrap flow, Fabrica intake/pipeline/register/recovery services

---

## File Structure

- Modify: `lib/dispatch/telegram-bootstrap-hook.ts`
  - Make post-classification handoff durable, idempotent, and resumable.
- Modify: `lib/dispatch/telegram-bootstrap-session.ts`
  - Strengthen session ownership and checkpoint persistence semantics.
- Modify: `lib/intake/pipeline.ts`
  - Align pipeline checkpoints with durable bootstrap truth.
- Modify: `lib/tools/admin/project-register.ts`
  - Remove silent split-brain windows or record explicit recoverable orphan state.
- Modify: `lib/intake/lib/artifact-cleanup.ts`
  - Cover all relevant register/bootstrap artifacts or checkpoint them explicitly.
- Modify: `lib/services/heartbeat/index.ts`
  - Make heartbeat bootstrap recovery consume the same authoritative state.
- Modify: `lib/setup/gateway-lifecycle-hook.ts`
  - Make gateway-start bootstrap recovery consume the same authoritative state.
- Modify: `lib/services/heartbeat/review.ts`
  - Reduce reviewer completion authority conflicts if they still compete with agent-review truth.
- Modify: `lib/services/heartbeat/passes.ts`
  - Keep reviewer recovery consistent with canonical reviewer decision handling.
- Modify: `index.ts`
  - Reduce plugin registration noise in CLI flows while keeping gateway observability.
- Modify: `lib/github/register-webhook-route.ts`
  - Gate polling-only informational logs to gateway-appropriate contexts.
- Test: `tests/unit/telegram-bootstrap-hook.test.ts`
- Test: `tests/unit/gateway-lifecycle-hook.test.ts`
- Test: `tests/unit/project-register.test.ts`
- Test: `tests/unit/notify.test.ts`
- Test: `tests/unit/reviewer-completion.test.ts`
- Test: `tests/unit/reviewer-poll-pass.test.ts`
- Test: `tests/unit/reactive-dispatch-hook.test.ts`
- Test: `tests/e2e/orchestration-smoke.e2e.test.ts`
- Optional Test/Create: `tests/unit/bootstrap-register-orphaning.test.ts`
  - Add if current test files cannot express the split-brain checkpoint scenario cleanly.

### Task 1: Freeze the Current Failure with Tests

**Files:**
- Modify: `tests/unit/telegram-bootstrap-hook.test.ts`
- Modify: `tests/unit/gateway-lifecycle-hook.test.ts`
- Modify: `tests/unit/project-register.test.ts`

- [ ] **Step 1: Write the failing bootstrap persistence test**

```ts
it("persists bootstrapping state before the first acknowledgment send", async () => {
  const sendCalls: string[] = [];
  const runCommand = vi.fn(async (args: string[]) => {
    if (args.includes("message") && args.includes("send")) {
      const session = await readTelegramBootstrapSession(workspaceDir, "telegram:6951571380");
      expect(session?.status).toBe("bootstrapping");
      expect(session?.attemptId).toBeDefined();
      sendCalls.push(args.join(" "));
    }
    return { stdout: "{\"ok\":true}", stderr: "", code: 0 } as any;
  });

  const ctxForTest = { ...ctx, runCommand } as any;

  await triggerBootstrapFromClassifiedDm(ctxForTest, {
    conversationId: "telegram:6951571380",
    rawIdea: "Build a simple Python CLI for todo summary",
    stackHint: "python-cli",
    projectSlug: "todo-summary",
    language: "en",
  });

  expect(sendCalls.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the targeted bootstrap test and verify it fails**

Run: `cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica && npx vitest run tests/unit/telegram-bootstrap-hook.test.ts -t "persists bootstrapping state before the first acknowledgment send"`

Expected: FAIL because the current implementation either sends before durable `bootstrapping` state exists or does not expose an attempt-scoped durable record.

- [ ] **Step 3: Write the failing recovery supersession test**

```ts
it("does not let an older recovery resume overwrite a newer bootstrap attempt", async () => {
  await upsertTelegramBootstrapSession(workspaceDir, {
    conversationId: "telegram:6951571380",
    attemptId: "attempt-old",
    status: "bootstrapping",
    nextRetryAt: new Date(Date.now() - 1_000).toISOString(),
    rawIdea: "old idea",
    sourceRoute: { channel: "telegram", channelId: "6951571380" },
  } as any);

  await upsertTelegramBootstrapSession(workspaceDir, {
    conversationId: "telegram:6951571380",
    attemptId: "attempt-new",
    status: "bootstrapping",
    nextRetryAt: new Date(Date.now() - 1_000).toISOString(),
    rawIdea: "new idea",
    sourceRoute: { channel: "telegram", channelId: "6951571380" },
  } as any);

  const recovered = await recoverDueBootstraps(ctx, workspaceDir);
  const session = await readTelegramBootstrapSession(workspaceDir, "telegram:6951571380");

  expect(recovered).toBe(1);
  expect(session?.attemptId).toBe("attempt-new");
});
```

- [ ] **Step 4: Run the recovery test and verify it fails**

Run: `cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica && npx vitest run tests/unit/telegram-bootstrap-hook.test.ts -t "does not let an older recovery resume overwrite a newer bootstrap attempt"`

Expected: FAIL because current session ownership is conversation-scoped and not strong enough to reject stale resumptions.

- [ ] **Step 5: Write the failing register split-brain test**

```ts
it("does not leave workflow residue without durable project truth", async () => {
  mockCreateProjectForumTopic.mockRejectedValue(new Error("telegram topic create failed"));

  await expect(registerProject(ctx as any, {
    projectName: "todo-summary",
    repoPath: "/tmp/todo-summary",
    sourceRoute: { channel: "telegram", channelId: "6951571380" },
  } as any)).rejects.toThrow("telegram topic create failed");

  const projects = await readProjects(workspaceDir);
  await expect(fs.access(path.join(workspaceDir, "projects", "todo-summary", "workflow.yaml"))).rejects.toThrow();
  expect(projects.projects["todo-summary"]).toBeUndefined();
});
```

- [ ] **Step 6: Run the register test and verify it fails**

Run: `cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica && npx vitest run tests/unit/project-register.test.ts -t "does not leave workflow residue without durable project truth"`

Expected: FAIL because the current register path can materialize workflow state before the durable project record exists.

- [ ] **Step 7: Commit the failing-test checkpoint**

```bash
cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica
git add tests/unit/telegram-bootstrap-hook.test.ts tests/unit/gateway-lifecycle-hook.test.ts tests/unit/project-register.test.ts
git commit -m "test(hot-path): freeze bootstrap and register regressions"
```

### Task 2: Make Bootstrap Handoff Durable

**Files:**
- Modify: `lib/dispatch/telegram-bootstrap-session.ts`
- Modify: `lib/dispatch/telegram-bootstrap-hook.ts`
- Test: `tests/unit/telegram-bootstrap-hook.test.ts`

- [ ] **Step 1: Extend the bootstrap session shape with durable attempt ownership and checkpoint fields**

```ts
export type TelegramBootstrapSession = {
  conversationId: string;
  attemptId: string;
  status: "pending_classify" | "classifying" | "bootstrapping" | "dispatching" | "completed" | "failed";
  bootstrapStep?: "classified" | "ack_sent" | "pipeline_started" | "project_registered" | "dm_final_sent";
  attemptSeq: number;
  rawIdea: string;
  projectName?: string;
  stackHint?: string;
  language?: string;
  sourceRoute: { channel: "telegram"; channelId: string; accountId?: string };
  classification?: {
    intent: string;
    confidence?: number;
    projectSlug?: string;
    stackHint?: string;
    language?: string;
  };
  attemptCount: number;
  nextRetryAt?: string | null;
  lastError?: string | null;
  updatedAt: string;
};
```

- [ ] **Step 2: Run type-aware session tests to verify the new shape fails until wired through**

Run: `cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica && npx vitest run tests/unit/telegram-bootstrap-hook.test.ts`

Expected: FAIL in the new attempt/checkpoint assertions because the hook still writes the older session model.

- [ ] **Step 3: Refactor the post-classification path so persistence happens before the first send**

```ts
async function enterBootstrapping(
  ctx: PluginContext,
  workspaceDir: string,
  input: ClassifiedBootstrapInput,
): Promise<TelegramBootstrapSession> {
  const session = await upsertTelegramBootstrapSession(workspaceDir, {
    conversationId: input.conversationId,
    attemptId: input.attemptId,
    attemptSeq: input.attemptSeq,
    status: "bootstrapping",
    bootstrapStep: "classified",
    rawIdea: input.rawIdea,
    projectName: input.projectSlug,
    stackHint: input.stackHint,
    language: input.language,
    sourceRoute: input.sourceRoute,
    classification: input.classification,
    attemptCount: 0,
    nextRetryAt: null,
    lastError: null,
  });

  return session;
}
```

- [ ] **Step 4: Consolidate live execution and recovery into one checkpoint-driven bootstrap runner**

```ts
async function runBootstrapAttempt(
  ctx: PluginContext,
  workspaceDir: string,
  session: TelegramBootstrapSession,
): Promise<TelegramBootstrapSession> {
  let current = session;

  if (current.bootstrapStep === "classified") {
    await sendInitialBootstrapAck(ctx, current);
    current = await upsertTelegramBootstrapSession(workspaceDir, {
      ...current,
      bootstrapStep: "ack_sent",
      lastError: null,
      nextRetryAt: null,
    });
  }

  if (current.bootstrapStep === "ack_sent") {
    current = await upsertTelegramBootstrapSession(workspaceDir, {
      ...current,
      bootstrapStep: "pipeline_started",
    });
    current = await runBootstrapPipelineAndPersist(ctx, workspaceDir, current);
  }

  return current;
}
```

- [ ] **Step 5: Re-run the bootstrap hook tests and make the new durability assertions pass**

Run: `cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica && npx vitest run tests/unit/telegram-bootstrap-hook.test.ts`

Expected: PASS for the new durability assertions and no regressions in existing bootstrap behavior.

- [ ] **Step 6: Commit the durable bootstrap handoff**

```bash
cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica
git add lib/dispatch/telegram-bootstrap-session.ts lib/dispatch/telegram-bootstrap-hook.ts tests/unit/telegram-bootstrap-hook.test.ts
git commit -m "fix(telegram): persist bootstrap state before side effects"
```

### Task 3: Strengthen Attempt Ownership and Recovery

**Files:**
- Modify: `lib/dispatch/telegram-bootstrap-session.ts`
- Modify: `lib/dispatch/telegram-bootstrap-hook.ts`
- Modify: `lib/services/heartbeat/index.ts`
- Modify: `lib/setup/gateway-lifecycle-hook.ts`
- Test: `tests/unit/telegram-bootstrap-hook.test.ts`
- Test: `tests/unit/gateway-lifecycle-hook.test.ts`

- [ ] **Step 1: Add durable lease and supersession helpers**

```ts
export async function claimBootstrapAttempt(
  workspaceDir: string,
  conversationId: string,
  attemptId: string,
): Promise<TelegramBootstrapSession | null> {
  const current = await readTelegramBootstrapSession(workspaceDir, conversationId);
  if (!current) return null;
  if (current.attemptId !== attemptId) return null;
  if (current.status === "completed" || current.status === "failed") return null;

  return upsertTelegramBootstrapSession(workspaceDir, {
    ...current,
    recoveryLease: {
      owner: attemptId,
      leasedAt: new Date().toISOString(),
    },
  } as any);
}
```

- [ ] **Step 2: Run the ownership/recovery tests and verify the old behavior still fails**

Run: `cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica && npx vitest run tests/unit/telegram-bootstrap-hook.test.ts tests/unit/gateway-lifecycle-hook.test.ts`

Expected: FAIL until recovery callers reject stale attempts and reuse the same runner.

- [ ] **Step 3: Update gateway-start and heartbeat recovery to resume only current claimable attempts**

```ts
const claim = await claimBootstrapAttempt(workspaceDir, session.conversationId, session.attemptId);
if (!claim) return 0;

await runBootstrapAttempt(ctx, workspaceDir, claim);
```

- [ ] **Step 4: Ensure retry scheduling updates session metadata instead of deleting or regressing the session**

```ts
async function scheduleBootstrapRetry(
  workspaceDir: string,
  session: TelegramBootstrapSession,
  error: unknown,
): Promise<TelegramBootstrapSession> {
  return upsertTelegramBootstrapSession(workspaceDir, {
    ...session,
    status: "bootstrapping",
    attemptCount: session.attemptCount + 1,
    lastError: error instanceof Error ? error.message : String(error),
    nextRetryAt: new Date(Date.now() + BOOTSTRAP_RETRY_DELAY_MS).toISOString(),
  });
}
```

- [ ] **Step 5: Re-run recovery tests and verify supersession/restart behavior passes**

Run: `cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica && npx vitest run tests/unit/telegram-bootstrap-hook.test.ts tests/unit/gateway-lifecycle-hook.test.ts`

Expected: PASS, including stale attempt rejection and gateway/heartbeat recovery coverage.

- [ ] **Step 6: Commit the ownership and recovery changes**

```bash
cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica
git add lib/dispatch/telegram-bootstrap-session.ts lib/dispatch/telegram-bootstrap-hook.ts lib/services/heartbeat/index.ts lib/setup/gateway-lifecycle-hook.ts tests/unit/telegram-bootstrap-hook.test.ts tests/unit/gateway-lifecycle-hook.test.ts
git commit -m "fix(telegram): harden bootstrap ownership and recovery"
```

### Task 4: Eliminate Silent Register Split-Brain

**Files:**
- Modify: `lib/intake/pipeline.ts`
- Modify: `lib/tools/admin/project-register.ts`
- Modify: `lib/intake/lib/artifact-cleanup.ts`
- Test: `tests/unit/project-register.test.ts`
- Test: `tests/unit/bootstrap-register-orphaning.test.ts`

- [ ] **Step 1: Add the failing test for explicit orphan checkpoint or atomic register**

```ts
it("records explicit orphan state when register fails after repo provisioning", async () => {
  mockProvisionRepo.mockResolvedValue({
    repoPath: "/tmp/todo-summary",
    owner: "MestreY0d4-Uninter",
    name: "todo-summary",
  });
  mockCreateProjectForumTopic.mockRejectedValue(new Error("topic failed"));

  const result = await runPipeline(ctx as any, bootstrapInput);

  expect(result.success).toBe(false);
  expect(result.payload?.metadata?.orphaned_artifacts).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "github_repo" }),
  ]));
  await expect(fs.access(path.join(workspaceDir, "projects", "todo-summary", "workflow.yaml"))).rejects.toThrow();
});
```

- [ ] **Step 2: Run the register/orphaning tests and verify they fail**

Run: `cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica && npx vitest run tests/unit/project-register.test.ts tests/unit/bootstrap-register-orphaning.test.ts`

Expected: FAIL because the current flow either leaves workflow residue or does not expose explicit orphan state for recovery.

- [ ] **Step 3: Move workflow override materialization behind durable project truth or explicit orphan ownership**

```ts
const registration = await writeProjects(workspaceDir, (projects) => {
  projects[slug] = buildRegisteredProjectRecord(input);
  return projects;
});

try {
  await materializeWorkflowOverride(workspaceDir, slug, workflowOverride);
  await createAndBindProjectTopic(ctx, slug, registration.project);
} catch (error) {
  await markProjectRegisterOrphan(workspaceDir, slug, {
    error: error instanceof Error ? error.message : String(error),
    artifacts: collectRegisterArtifactsSoFar(...),
  });
  throw error;
}
```

- [ ] **Step 4: Extend cleanup coverage for any side effect that can exist after partial register failure**

```ts
switch (artifact.type) {
  case "github_repo":
    return cleanupGithubRepo(...);
  case "github_issue":
    return cleanupGithubIssue(...);
  case "forum_topic":
    return cleanupTelegramForumTopic(...);
  case "workflow_override":
    return cleanupWorkflowOverride(...);
}
```

- [ ] **Step 5: Re-run register tests and verify split-brain is gone or explicitly owned**

Run: `cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica && npx vitest run tests/unit/project-register.test.ts tests/unit/bootstrap-register-orphaning.test.ts`

Expected: PASS, with no silent `workflow.yaml` residue after the failing path.

- [ ] **Step 6: Commit the register/provision correction**

```bash
cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica
git add lib/intake/pipeline.ts lib/tools/admin/project-register.ts lib/intake/lib/artifact-cleanup.ts tests/unit/project-register.test.ts tests/unit/bootstrap-register-orphaning.test.ts
git commit -m "fix(intake): eliminate silent register split-brain"
```

### Task 5: Tighten Reviewer Recovery Authority

**Files:**
- Modify: `lib/services/heartbeat/review.ts`
- Modify: `lib/services/heartbeat/passes.ts`
- Test: `tests/unit/reviewer-completion.test.ts`
- Test: `tests/unit/reviewer-poll-pass.test.ts`

- [ ] **Step 1: Add the failing reviewer-authority test**

```ts
it("does not let provider review polling override a completed reviewer-text decision", async () => {
  mockReviewerSessionDecision.mockResolvedValue("reject");
  mockProviderReviewStatus.mockResolvedValue("APPROVED");

  const result = await performReviewerPollPass(ctx as any, state);

  expect(result.transitions).toEqual([
    expect.objectContaining({ event: "REJECT" }),
  ]);
  expect(mockProviderReviewStatus).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run reviewer completion tests and verify the new authority test fails**

Run: `cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica && npx vitest run tests/unit/reviewer-completion.test.ts tests/unit/reviewer-poll-pass.test.ts`

Expected: FAIL if provider review polling can still compete with canonical reviewer-text truth in the same active path.

- [ ] **Step 3: Gate provider-side review polling to recovery-only situations**

```ts
if (project.runtime?.reviewerDecisionSource === "agent_session") {
  return noReviewTransition();
}

if (!hasLiveReviewerSession(project) && canUseProviderReviewRecovery(project)) {
  return recoverFromProviderReviewState(...);
}
```

- [ ] **Step 4: Re-run reviewer tests and verify deterministic authority**

Run: `cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica && npx vitest run tests/unit/reviewer-completion.test.ts tests/unit/reviewer-poll-pass.test.ts`

Expected: PASS with reviewer-text remaining canonical during active agent review flow.

- [ ] **Step 5: Commit the reviewer authority cleanup**

```bash
cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica
git add lib/services/heartbeat/review.ts lib/services/heartbeat/passes.ts tests/unit/reviewer-completion.test.ts tests/unit/reviewer-poll-pass.test.ts
git commit -m "fix(review): keep reviewer text as canonical authority"
```

### Task 6: Reduce CLI Noise Without Hiding Gateway Signals

**Files:**
- Modify: `index.ts`
- Modify: `lib/github/register-webhook-route.ts`
- Test: `tests/unit/reactive-dispatch-hook.test.ts`
- Create or Modify: `tests/unit/plugin-registration-logging.test.ts`

- [ ] **Step 1: Add the failing CLI log calibration test**

```ts
it("does not emit plugin registration info logs during non-gateway CLI loads", async () => {
  const info = vi.fn();
  const debug = vi.fn();

  registerPlugin(api as any, {
    ...ctx,
    logger: { info, debug, warn: vi.fn(), error: vi.fn() },
    runtimeMode: "cli",
  } as any);

  expect(info).not.toHaveBeenCalledWith(expect.stringContaining("Fabrica plugin registered"));
});
```

- [ ] **Step 2: Run the log calibration tests and verify the new one fails**

Run: `cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica && npx vitest run tests/unit/plugin-registration-logging.test.ts`

Expected: FAIL because registration and polling-only messages are still emitted too broadly today.

- [ ] **Step 3: Gate registration and webhook informational logs by runtime context**

```ts
if (isGatewayServerProcess()) {
  logger.info(summaryMessage);
} else {
  logger.debug(summaryMessage);
}
```

```ts
if (isGatewayServerProcess()) {
  logger.info("GitHub webhook route not registered: running in polling-only mode ...");
}
```

- [ ] **Step 4: Re-run the logging tests and verify only gateway-appropriate output remains**

Run: `cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica && npx vitest run tests/unit/plugin-registration-logging.test.ts`

Expected: PASS, with CLI path quiet by default and gateway path still covered.

- [ ] **Step 5: Commit the CLI log calibration**

```bash
cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica
git add index.ts lib/github/register-webhook-route.ts tests/unit/plugin-registration-logging.test.ts
git commit -m "fix(logging): quiet Fabrica CLI load noise"
```

### Task 7: End-to-End Verification and Real Telegram Validation

**Files:**
- Modify: `tests/e2e/orchestration-smoke.e2e.test.ts`
- Modify: `package.json` only if a missing verification lane is required
- Document verification evidence in the branch summary or release notes after tests

- [ ] **Step 1: Extend or add a smoke test for bootstrap-to-dispatch continuity**

```ts
it("advances from classified bootstrap to registered project and initial dispatch", async () => {
  const result = await runBootstrapScenario({
    idea: "Build a simple Python CLI for todo summary",
    transport: "telegram",
  });

  expect(result.bootstrap.status).toBe("completed");
  expect(result.project.slug).toBe("todo-summary");
  expect(result.project.issueLabel).toBe("Doing");
  expect(result.dispatch.role).toBe("developer");
});
```

- [ ] **Step 2: Run the focused hot-path suite**

Run: `cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica && npm run test:hot-path`

Expected: PASS

- [ ] **Step 3: Run the full verification suite**

Run: `cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica && npm run test:all && npm run build && npm run typecheck && npm run verify:runtime-boundary && node scripts/verify-installability.mjs`

Expected:
- all unit tests pass
- all e2e tests pass
- build and typecheck pass
- runtime boundary verification passes
- installability smoke passes

- [ ] **Step 4: Deploy the corrected plugin locally and validate with a real Telegram DM**

Run:

```bash
cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica
bash scripts/deploy.sh --local-only
script -q -c 'openclaw plugins inspect fabrica' /dev/null
openclaw fabrica status -w /home/mateus/.openclaw/workspace
```

Then send the real Telegram DM prompt and verify:
- first DM ack is restored
- project becomes registered
- topic link DM is sent
- project enters initial dispatch

Expected: live hot path succeeds without manual intervention.

- [ ] **Step 5: Commit the verification/test adjustments**

```bash
cd /home/mateus/Fabrica/.worktrees/release-integration/fabrica
git add tests/e2e/orchestration-smoke.e2e.test.ts package.json
git commit -m "test(hot-path): verify bootstrap-to-dispatch flow"
```

## Self-Review

- Spec coverage:
  - durable bootstrap handoff: Tasks 1-3
  - stronger attempt ownership: Task 3
  - register/provision truth alignment: Task 4
  - recovery unification: Tasks 2-3
  - downstream review/test determinism: Task 5
  - CLI log calibration: Task 6
  - real validation and release gate evidence: Task 7
- Placeholder scan:
  - no `TODO`/`TBD` placeholders remain
  - optional test file is explicitly scoped and only created if current tests cannot express the case cleanly
- Type consistency:
  - uses `attemptId`, `attemptSeq`, `bootstrapStep`, and recovery lease terminology consistently
  - keeps reviewer-text authority canonical and provider polling recovery-only
