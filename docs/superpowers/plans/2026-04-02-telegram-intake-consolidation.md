# Telegram Intake Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telegram DM intake durably reliable for clear project requests, add a temporary Telegram validation harness that replaces manual operator work, and keep iterating until one fully independent test project passes end-to-end.

**Architecture:** Consolidate the existing intake around durable bootstrap session ownership instead of synchronous classify timing. Merge the coupled classify/handoff/cleanup/suppress changes into one implementation slice, then adapt `openclaw-telegram-mcp` into a temporary operator harness that can drive DM prompts, commands, and topic monitoring without coupling to the plugin. Final validation is a real Telegram E2E loop: send prompt as a real user, observe runtime artifacts, fix regressions, and rerun until a project completes.

**Tech Stack:** TypeScript, Vitest, OpenClaw plugin SDK, existing Fabrica bootstrap/session/heartbeat recovery, Python, Telethon, FastMCP, pytest, `kiro-cli` as read-only second opinion

---

### File Structure

**Core intake flow**
- Modify: `lib/dispatch/telegram-bootstrap-hook.ts`
  - deterministic first-pass parsing for clear project DMs
  - durable bootstrap creation before classify timing can lose the request
  - explicit classify/handoff/recovery outcomes
  - no silent fail-open on short classify waits

- Modify: `lib/dispatch/telegram-bootstrap-session.ts`
  - canonical Telegram bootstrap identity helper
  - durable early bootstrap states
  - explicit cleanup/expiry helpers
  - attempt ownership and classify identity persistence

**Bootstrap recovery and observability**
- Modify: `lib/services/heartbeat/index.ts`
  - cover early bootstrap reconciliation and cleanup in the existing recovery owner

- Modify: `lib/services/heartbeat/passes.ts`
  - reconcile pending/classifying attempts through the normal heartbeat/recovery path if this is where the recovery loop currently lives

- Modify: `lib/audit.ts` or existing audit call sites
  - no new subsystem
  - only support minimal event payload consistency for early-path debugging

**Tests for intake**
- Modify: `tests/unit/telegram-bootstrap-hook.test.ts`
- Modify: `tests/unit/telegram-bootstrap-flow.test.ts`
- Add if needed: `tests/unit/telegram-bootstrap-session.test.ts`

**Temporary Telegram validation harness**
- Modify: `/home/mateus/Fabrica/openclaw-telegram-mcp/server.py`
  - add the minimal extra primitives required to replace manual operator work

- Add: `/home/mateus/Fabrica/openclaw-telegram-mcp/runner.py`
  - temporary scenario runner that sends prompts/commands and monitors DM/topic flow without coupling to the plugin

- Modify: `/home/mateus/Fabrica/openclaw-telegram-mcp/tests/test_wait.py`
- Modify: `/home/mateus/Fabrica/openclaw-telegram-mcp/tests/test_read.py`
- Add: `/home/mateus/Fabrica/openclaw-telegram-mcp/tests/test_runner.py`

**Verification**
- Runtime validation on local OpenClaw with real Telegram traffic
- Independent E2E driven through the temporary Telegram harness, not by manual user intervention

**Kiro review lane**
- No code edits
- No file modifications
- Read-only review before each risky implementation slice and before each E2E rerun decision

---

### Task 1: Lock Down Canonical Intake Identity And Deterministic Parsing

**Files:**
- Modify: `lib/dispatch/telegram-bootstrap-hook.ts`
- Modify: `lib/dispatch/telegram-bootstrap-session.ts`
- Test: `tests/unit/telegram-bootstrap-hook.test.ts`

- [ ] **Step 1: Write the failing identity and free-text extraction tests**

```ts
it("extracts project name from 'called <slug>' in a clear project request", async () => {
  registerTelegramBootstrapHook(api, ctx);

  await handler?.(
    {
      content: "Build a small Python CLI tool called csv-peek",
      metadata: {},
    },
    { channelId: "telegram", conversationId: "6951571380" },
  );

  const session = await readTelegramBootstrapSession(
    workspaceDir,
    toCanonicalTelegramBootstrapConversationId("6951571380"),
  );

  expect(session?.projectName).toBe("csv-peek");
});
```

```ts
it("uses one canonical conversation identity across message_received and suppress paths", async () => {
  const canonicalId = toCanonicalTelegramBootstrapConversationId("6951571380");

  await upsertTelegramBootstrapSession(workspaceDir, {
    conversationId: canonicalId,
    rawIdea: "Build a Python CLI called csv-peek",
    status: "pending_classify",
  });

  const session = await readTelegramBootstrapSession(workspaceDir, "6951571380");
  expect(session?.conversationId).toBe(canonicalId);
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```bash
npx vitest run tests/unit/telegram-bootstrap-hook.test.ts -t "extracts project name from 'called <slug>' in a clear project request"
npx vitest run tests/unit/telegram-bootstrap-hook.test.ts -t "uses one canonical conversation identity across message_received and suppress paths"
```

Expected:
- first test fails because the primary parse layer does not yet extract free-text `called <slug>`
- second test fails or requires helper usage changes because identity is not canonicalized everywhere

- [ ] **Step 3: Review this task with Kiro before implementation**

```bash
kiro-cli chat --agent kiro_planner --no-interactive "Review this task only. Goal: add deterministic free-text project name extraction for clear project requests and unify canonical Telegram bootstrap conversation identity across hooks. Relevant files: lib/dispatch/telegram-bootstrap-hook.ts, lib/dispatch/telegram-bootstrap-session.ts, tests/unit/telegram-bootstrap-hook.test.ts. Do not write code. Do not modify files. Identify design and regression risks only."
```

Expected:
- Kiro returns only review/risk commentary

- [ ] **Step 4: Implement deterministic parsing and canonical identity helpers**

Implementation requirements:
- add one canonical Telegram bootstrap identity helper in `telegram-bootstrap-session.ts`
- route all bootstrap read/write/suppress entry points through it
- extend the primary parse layer in `telegram-bootstrap-hook.ts` to extract `called`, `named`, and `chamado` forms conservatively
- do not broaden parsing beyond those explicit free-text forms

- [ ] **Step 5: Run targeted tests to verify they pass**

Run:

```bash
npx vitest run tests/unit/telegram-bootstrap-hook.test.ts -t "extracts project name from 'called <slug>' in a clear project request"
npx vitest run tests/unit/telegram-bootstrap-hook.test.ts -t "uses one canonical conversation identity across message_received and suppress paths"
```

Expected:
- both tests PASS

- [ ] **Step 6: Commit**

```bash
git add lib/dispatch/telegram-bootstrap-hook.ts lib/dispatch/telegram-bootstrap-session.ts tests/unit/telegram-bootstrap-hook.test.ts
git commit -m "fix(telegram): unify intake identity and deterministic naming"
```

### Task 2: Consolidate Durable Classify, Explicit Handoff, And Explicit Cleanup

**Files:**
- Modify: `lib/dispatch/telegram-bootstrap-hook.ts`
- Modify: `lib/dispatch/telegram-bootstrap-session.ts`
- Modify: `lib/services/heartbeat/index.ts`
- Modify: `lib/services/heartbeat/passes.ts`
- Test: `tests/unit/telegram-bootstrap-hook.test.ts`
- Test: `tests/unit/telegram-bootstrap-flow.test.ts`
- Add if needed: `tests/unit/telegram-bootstrap-session.test.ts`

- [ ] **Step 1: Write the failing coupled-state tests**

```ts
it("keeps bootstrap state when classify wait times out but the classify result arrives later", async () => {
  mockSubagentRun.mockResolvedValue({ sessionKey: "genesis-classify-csv-peek" });
  mockWaitForRun.mockResolvedValue({ status: "timeout" });

  registerTelegramBootstrapHook(api, ctx);

  await handler?.(
    { content: "Build a small Python CLI tool called csv-peek", metadata: {} },
    { channelId: "telegram", conversationId: "6951571380" },
  );

  const session = await readTelegramBootstrapSession(
    workspaceDir,
    toCanonicalTelegramBootstrapConversationId("6951571380"),
  );

  expect(session?.status === "pending_classify" || session?.status === "classifying").toBe(true);
});
```

```ts
it("returns explicit handoff outcomes instead of silently no-oping", async () => {
  const result = await startFreshBootstrapResumeForTest(ctx, workspaceDir, "telegram:6951571380");
  expect(["started", "already_active", "superseded", "failed_to_start"]).toContain(result.outcome);
});
```

```ts
it("does not silently delete expired classify state on read", async () => {
  await writeTelegramBootstrapSession(workspaceDir, expiredClassifyingSession);

  const session = await readTelegramBootstrapSession(
    workspaceDir,
    expiredClassifyingSession.conversationId,
  );

  expect(session).not.toBeNull();
});
```

```ts
it("releases suppress only through explicit expiry or failure handling", async () => {
  const active = await readTelegramBootstrapSession(workspaceDir, "telegram:6951571380");
  expect(shouldSuppressTelegramBootstrapReply(active)).toBe(true);

  await expireBootstrapAttemptForTest(workspaceDir, "telegram:6951571380");
  const expired = await readTelegramBootstrapSession(workspaceDir, "telegram:6951571380");
  expect(shouldSuppressTelegramBootstrapReply(expired)).toBe(false);
});
```

- [ ] **Step 2: Run the coupled slice tests to verify they fail**

Run:

```bash
npx vitest run tests/unit/telegram-bootstrap-hook.test.ts -t "keeps bootstrap state when classify wait times out but the classify result arrives later"
npx vitest run tests/unit/telegram-bootstrap-hook.test.ts -t "returns explicit handoff outcomes instead of silently no-oping"
npx vitest run tests/unit/telegram-bootstrap-flow.test.ts -t "does not silently delete expired classify state on read"
npx vitest run tests/unit/telegram-bootstrap-hook.test.ts -t "releases suppress only through explicit expiry or failure handling"
```

Expected:
- failures showing current early intake still fails open, no-ops silently, or cleans up on read

- [ ] **Step 3: Review this coupled slice with Kiro before implementation**

```bash
kiro-cli chat --agent kiro_planner --no-interactive "Review this implementation slice only. Goal: consolidate durable classify state, explicit classify-to-bootstrap handoff outcomes, and explicit cleanup/suppress lifecycle in the existing Telegram intake flow. Relevant files: lib/dispatch/telegram-bootstrap-hook.ts, lib/dispatch/telegram-bootstrap-session.ts, lib/services/heartbeat/index.ts, lib/services/heartbeat/passes.ts, tests/unit/telegram-bootstrap-hook.test.ts, tests/unit/telegram-bootstrap-flow.test.ts. Do not write code. Do not modify files. Identify correctness and sequencing risks only."
```

Expected:
- Kiro flags stale-attempt, recovery, or suppress-lifecycle risks only

- [ ] **Step 4: Implement durable early bootstrap states and classify identity persistence**

Implementation requirements:
- persist enough classify-session identity to reconcile later through the existing recovery owner
- stop deleting early bootstrap state when short classify waits abort or timeout
- keep `pending_classify` and `classifying` durable
- do not introduce a new recovery subsystem

- [ ] **Step 5: Implement explicit handoff outcomes and explicit cleanup**

Implementation requirements:
- replace silent handoff no-ops with explicit outcomes:
  - `started`
  - `already_active`
  - `superseded`
  - `failed_to_start`
- move expiry/cleanup decisions out of read-time behavior and into explicit recovery/cleanup helpers
- make suppression lifecycle follow explicit bootstrap lifecycle rather than side effects of reads

- [ ] **Step 6: Implement reconciliation in the existing heartbeat/bootstrap recovery owner**

Implementation requirements:
- recovery must be able to revisit `pending_classify` and `classifying`
- reconciliation must be keyed by durable bootstrap attempt + classify session identity, not by transient run timing
- stale late results must not overwrite newer attempts

- [ ] **Step 7: Run the coupled slice tests to verify they pass**

Run:

```bash
npx vitest run tests/unit/telegram-bootstrap-hook.test.ts tests/unit/telegram-bootstrap-flow.test.ts tests/unit/telegram-bootstrap-session.test.ts
```

Expected:
- coupled slice tests PASS
- no read-time deletion regressions remain

- [ ] **Step 8: Commit**

```bash
git add lib/dispatch/telegram-bootstrap-hook.ts lib/dispatch/telegram-bootstrap-session.ts lib/services/heartbeat/index.ts lib/services/heartbeat/passes.ts tests/unit/telegram-bootstrap-hook.test.ts tests/unit/telegram-bootstrap-flow.test.ts tests/unit/telegram-bootstrap-session.test.ts
git commit -m "fix(telegram): consolidate durable classify and recovery handoff"
```

### Task 3: Close Attempt Metadata Gaps And Early-Path Audit Contracts

**Files:**
- Modify: `lib/dispatch/telegram-bootstrap-hook.ts`
- Modify: `lib/dispatch/telegram-bootstrap-session.ts`
- Test: `tests/unit/telegram-bootstrap-hook.test.ts`
- Test: `tests/unit/telegram-bootstrap-flow.test.ts`

- [ ] **Step 1: Write the failing attempt-sequencing and audit tests**

```ts
it("audits classify wait abort with canonical identity and attempt metadata", async () => {
  await handler?.(
    { content: "Build a small Python CLI tool called csv-peek", metadata: {} },
    { channelId: "telegram", conversationId: "6951571380" },
  );

  expect(mockAuditLog).toHaveBeenCalledWith(
    workspaceDir,
    "telegram_bootstrap_classify_wait_aborted",
    expect.objectContaining({
      conversationIdCanonical: "telegram:6951571380",
      attemptId: expect.any(String),
      attemptSeq: expect.any(Number),
    }),
  );
});
```

```ts
it("increments attemptSeq monotonically for newer bootstrap attempts on the same conversation", async () => {
  expect(secondAttempt.attemptSeq).toBe(firstAttempt.attemptSeq + 1);
});
```

```ts
it("ignores a stale late classify result for an older attempt", async () => {
  expect(reconcileResult).toEqual(expect.objectContaining({ outcome: "superseded" }));
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```bash
npx vitest run tests/unit/telegram-bootstrap-hook.test.ts -t "audits classify wait abort with canonical identity and attempt metadata"
npx vitest run tests/unit/telegram-bootstrap-hook.test.ts -t "increments attemptSeq monotonically for newer bootstrap attempts on the same conversation"
npx vitest run tests/unit/telegram-bootstrap-flow.test.ts -t "ignores a stale late classify result for an older attempt"
```

Expected:
- failures because audit payloads and attempt sequencing are not yet explicit enough

- [ ] **Step 3: Review this task with Kiro before implementation**

```bash
kiro-cli chat --agent kiro_planner --no-interactive "Review this task only. Goal: make early-path audit payloads minimally consistent and make attempt sequencing explicit enough for stale classify suppression. Relevant files: lib/dispatch/telegram-bootstrap-hook.ts, lib/dispatch/telegram-bootstrap-session.ts, tests/unit/telegram-bootstrap-hook.test.ts, tests/unit/telegram-bootstrap-flow.test.ts. Do not write code. Do not modify files. Identify observability and sequencing risks only."
```

Expected:
- Kiro returns only observability or sequencing concerns

- [ ] **Step 4: Implement minimal audit payload contracts and monotonic attempt sequencing**

Implementation requirements:
- early-path events must carry canonical conversation identity and attempt metadata
- define `attemptSeq` generation clearly within the existing session ownership model
- do not introduce a new sequencing subsystem

- [ ] **Step 5: Run the targeted tests to verify they pass**

Run:

```bash
npx vitest run tests/unit/telegram-bootstrap-hook.test.ts -t "audits classify wait abort with canonical identity and attempt metadata"
npx vitest run tests/unit/telegram-bootstrap-hook.test.ts -t "increments attemptSeq monotonically for newer bootstrap attempts on the same conversation"
npx vitest run tests/unit/telegram-bootstrap-flow.test.ts -t "ignores a stale late classify result for an older attempt"
```

Expected:
- all three tests PASS

- [ ] **Step 6: Commit**

```bash
git add lib/dispatch/telegram-bootstrap-hook.ts lib/dispatch/telegram-bootstrap-session.ts tests/unit/telegram-bootstrap-hook.test.ts tests/unit/telegram-bootstrap-flow.test.ts
git commit -m "fix(telegram): audit early bootstrap attempts explicitly"
```

### Task 4: Adapt `openclaw-telegram-mcp` Into A Temporary Operator Harness

**Files:**
- Modify: `/home/mateus/Fabrica/openclaw-telegram-mcp/server.py`
- Add: `/home/mateus/Fabrica/openclaw-telegram-mcp/runner.py`
- Modify: `/home/mateus/Fabrica/openclaw-telegram-mcp/tests/test_wait.py`
- Modify: `/home/mateus/Fabrica/openclaw-telegram-mcp/tests/test_read.py`
- Add: `/home/mateus/Fabrica/openclaw-telegram-mcp/tests/test_runner.py`

- [ ] **Step 1: Write the failing harness tests**

```python
def test_wait_telegram_returns_recent_messages_on_timeout(fake_client):
    result = asyncio.run(wait_impl(fake_client, 123, pattern="ack", topic_id=None, timeout=1, sender=None))
    assert "timeout" in result
    assert "last_messages" in result
```

```python
def test_runner_sends_prompt_and_records_dm_ack(monkeypatch):
    result = asyncio.run(run_scenario(
        bot_chat="bot",
        prompt="Build a small Python CLI tool called csv-peek",
        command=None,
        topic_id=None,
    ))
    assert result["dm_sent"] is True
    assert "dm_observation" in result
```

```python
def test_runner_can_send_commands_without_plugin_coupling(monkeypatch):
    result = asyncio.run(run_scenario(
        bot_chat="bot",
        prompt=None,
        command="/restart",
        topic_id=None,
    ))
    assert result["command_sent"] is True
```

- [ ] **Step 2: Run the harness tests to verify they fail**

Run:

```bash
cd /home/mateus/Fabrica/openclaw-telegram-mcp && ./.venv/bin/pytest -q tests/test_wait.py tests/test_read.py tests/test_runner.py
```

Expected:
- new runner tests fail because the temporary harness does not yet exist

- [ ] **Step 3: Review the harness scope with Kiro before implementation**

```bash
kiro-cli chat --agent kiro_planner --no-interactive "Review this task only. Goal: adapt openclaw-telegram-mcp into a temporary validation harness that can send DM prompts, send Telegram commands, and observe DM/topic flow without coupling to the Fabrica plugin. Relevant files: /home/mateus/Fabrica/openclaw-telegram-mcp/server.py, /home/mateus/Fabrica/openclaw-telegram-mcp/runner.py, tests under /home/mateus/Fabrica/openclaw-telegram-mcp/tests. Do not write code. Do not modify files. Identify over-coupling or reliability risks only."
```

Expected:
- Kiro returns only harness/reliability risks

- [ ] **Step 4: Implement the minimal extra Telegram primitives and temporary runner**

Implementation requirements:
- keep the harness generic enough to act like a real Telegram user
- allow:
  - DM send
  - command send
  - DM read/wait
  - topic read/wait or tail-like polling
- add a small `runner.py` that orchestrates those primitives for validation scenarios
- do not couple the harness to plugin internals or local plugin files

- [ ] **Step 5: Run the harness test suite to verify it passes**

Run:

```bash
cd /home/mateus/Fabrica/openclaw-telegram-mcp && ./.venv/bin/pytest -q
```

Expected:
- harness tests PASS

- [ ] **Step 6: Commit**

```bash
git -C /home/mateus/Fabrica/openclaw-telegram-mcp add server.py runner.py tests/test_wait.py tests/test_read.py tests/test_runner.py
git -C /home/mateus/Fabrica/openclaw-telegram-mcp commit -m "feat: add temporary telegram validation runner"
```

### Task 5: Run Focused Verification, Then Loop Independent E2E Until One Project Passes End-To-End

**Files:**
- Verify: `tests/unit/telegram-bootstrap-hook.test.ts`
- Verify: `tests/unit/telegram-bootstrap-flow.test.ts`
- Verify: `tests/unit/telegram-bootstrap-session.test.ts`
- Verify: `/home/mateus/Fabrica/openclaw-telegram-mcp/tests/test_runner.py`
- Runtime: local OpenClaw + real Telegram + temporary harness

- [ ] **Step 1: Review final verification scope with Kiro**

```bash
kiro-cli chat --agent kiro_planner --no-interactive "Review the final verification scope only. Goal: verify Telegram intake consolidation and the temporary Telegram validation harness without missing structural regressions. Evidence sources will be unit tests, harness tests, runtime audit logs, bootstrap session files, and a real Telegram E2E prompt. Do not write code. Do not modify files. Identify missing validation angles only."
```

Expected:
- Kiro returns only missing validation angles or confirms coverage

- [ ] **Step 2: Run the focused Fabrica Telegram test suite**

Run:

```bash
npx vitest run tests/unit/telegram-bootstrap-hook.test.ts tests/unit/telegram-bootstrap-flow.test.ts tests/unit/telegram-bootstrap-session.test.ts
```

Expected:
- focused Telegram intake tests PASS

- [ ] **Step 3: Run the temporary Telegram harness test suite**

Run:

```bash
cd /home/mateus/Fabrica/openclaw-telegram-mcp && ./.venv/bin/pytest -q
```

Expected:
- harness tests PASS

- [ ] **Step 4: Run build verification and restart the local gateway**

Run:

```bash
npm run build
openclaw gateway restart
openclaw plugins inspect fabrica
```

Expected:
- build PASS
- gateway restart succeeds
- plugin status shows `loaded`

- [ ] **Step 5: Run a fully independent E2E through the harness**

Use the temporary harness, not a manual Telegram send:

```bash
cd /home/mateus/Fabrica/openclaw-telegram-mcp && ./.venv/bin/python runner.py --chat bot --prompt "Build a small Python CLI tool called csv-peek. Requirements: It reads a CSV file from a file path argument. By default, it prints the number of rows, the number of columns, and the column names. Add a --preview N flag to print the first N data rows. Add a --json flag to print the summary as JSON. Ignore empty trailing lines in the file. Include a README with usage examples. Include basic tests."
```

Expected:
- prompt is sent by the harness as a real Telegram user
- DM activity is observed by the harness
- bootstrap session materializes durably

- [ ] **Step 6: Inspect runtime artifacts and decide if the cycle passed or stalled**

Run:

```bash
openclaw fabrica status -w /home/mateus/.openclaw/workspace
ls /home/mateus/.openclaw/workspace/fabrica/bootstrap-sessions
tail -n 150 /home/mateus/.openclaw/workspace/fabrica/log/audit.log
```

Expected:
- intake state is explainable
- if the flow is healthy, project registration and downstream execution progress
- if stalled, the evidence shows where

- [ ] **Step 7: If the independent E2E stalls or regresses, fix and rerun**

Loop requirements:
- treat any stall, silent disappearance, duplicated replay, or wrong suppress behavior as a defect
- use runtime evidence first
- use Kiro as a read-only reviewer before each corrective patch if the root cause is ambiguous
- rerun tests, rebuild, restart the gateway, and rerun the independent harness scenario

Decision gate:
- do not stop after the first partial improvement
- continue the loop until one test project completes end-to-end successfully

- [ ] **Step 8: Exit only after one project passes end-to-end**

Success criteria:
- DM prompt sent by the harness
- durable bootstrap state created
- project registered
- topic created if applicable
- worker flow progresses without silent loss
- issue/PR flow reaches a valid terminal success state for the test project

Verification command set after the successful pass:

```bash
openclaw fabrica status -w /home/mateus/.openclaw/workspace
tail -n 200 /home/mateus/.openclaw/workspace/fabrica/log/audit.log
git status --short
```

Expected:
- workspace state is explainable
- audit trail matches the designed flow
- no hidden uncommitted regression outside the intended changes

## Self-Review

Spec coverage:
- deterministic-first intake is covered in Task 1
- durable classify state, reconciliation, explicit handoff, and explicit cleanup are covered in Task 2
- attempt metadata, stale classify handling, and audit payload consistency are covered in Task 3
- the temporary Telegram validation harness is covered in Task 4
- a fully independent E2E loop until success is covered in Task 5
- Kiro is explicitly included as read-only review in each risky slice and in final verification

Placeholder scan:
- no `TBD`, `TODO`, or deferred implementation language
- each task has concrete files, tests, commands, and expected outcomes
- the final loop task is explicit about rerun/fix criteria instead of implying them

Type consistency:
- canonical Telegram identity, early bootstrap states, explicit handoff outcomes, and `attemptSeq` names are stable across tasks
- the harness stays outside the plugin tree and is framed as a temporary validation tool only
