# Hot Path Operational Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a defensible hot-path audit of Fabrica that identifies the real operational bugs, separates them from intentional behavior, and yields a sequenced correction program without adding new product scope.

**Architecture:** The audit is executed as a sequence of evidence-gathering tasks over the live hot path. Each task maps one operational checkpoint, captures the source of truth, side effects, and recovery behavior, then records concrete findings in an audit report. The work is split into live-flow lanes and contamination lanes so stale state does not get mistaken for the primary cause.

**Tech Stack:** OpenClaw gateway/runtime, Fabrica plugin, local workspace state, git history, GitHub CLI, shell tooling, Vitest where needed for reproductions

---

## File Map

### Evidence and outputs

- Create: `docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md`
- Modify: `docs/superpowers/plans/2026-04-01-hot-path-operational-audit.md`

### Primary code areas to inspect during the audit

- Inspect: `lib/dispatch/telegram-bootstrap-hook.ts`
- Inspect: `lib/dispatch/telegram-bootstrap-session.ts`
- Inspect: `lib/telegram/topic-service.ts`
- Inspect: `lib/tools/admin/project-register.ts`
- Inspect: `lib/intake/index.ts`
- Inspect: `lib/intake/pipeline.ts`
- Inspect: `lib/intake/steps/register.ts`
- Inspect: `lib/dispatch/index.ts`
- Inspect: `lib/services/tick.ts`
- Inspect: `lib/tools/worker/work-finish.ts`
- Inspect: `lib/services/heartbeat/index.ts`
- Inspect: `lib/services/heartbeat/passes.ts`
- Inspect: `lib/services/heartbeat/review.ts`
- Inspect: `lib/dispatch/subagent-lifecycle-hook.ts`

### Runtime evidence locations

- Inspect: `/home/mateus/.openclaw/workspace/fabrica/projects.json`
- Inspect: `/home/mateus/.openclaw/workspace/fabrica/bootstrap-sessions/`
- Inspect: `/home/mateus/.openclaw/workspace/fabrica/log/audit.log`
- Inspect: `/home/mateus/.openclaw/workspace/fabrica/runtime/lifecycle.json`
- Inspect: `/home/mateus/.openclaw/agents/main/sessions/`
- Inspect: `/home/mateus/.openclaw/logs/commands.log`

### Reference docs

- Inspect: `docs/superpowers/specs/2026-04-01-hot-path-operational-audit-design.md`

## Task 1: Create The Audit Report Skeleton

**Files:**
- Create: `docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md`
- Inspect: `docs/superpowers/specs/2026-04-01-hot-path-operational-audit-design.md`

- [ ] **Step 1: Create the report skeleton with the final section structure**

Create the report with these sections:

```md
# Hot Path Operational Audit Report

Date: 2026-04-01
Status: In Progress

## Scope

## Environment Snapshot

## Live Flow Map

### Checkpoint 1: Telegram Intake

### Checkpoint 2: Bootstrap Session Persistence

### Checkpoint 3: Provision / Register

### Checkpoint 4: Project Activation / Dispatch

### Checkpoint 5: Review / Test Gates

### Checkpoint 6: Recovery / Retry / Dedup

## State Contamination

## Findings

### P0

### P1

### P2

## Intentional Behavior

## Correction Program
```

- [ ] **Step 2: Save the skeleton**

Run:

```bash
test -f docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md
```

Expected: command exits `0`

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md
git commit -m "docs(audit): scaffold hot path operational report"
```

## Task 2: Capture The Environment Snapshot

**Files:**
- Modify: `docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md`
- Inspect: `/home/mateus/.openclaw/workspace/fabrica/projects.json`
- Inspect: `/home/mateus/.openclaw/workspace/fabrica/log/audit.log`
- Inspect: `/home/mateus/.openclaw/agents/main/sessions/`
- Inspect: `/home/mateus/.openclaw/logs/commands.log`

- [ ] **Step 1: Record plugin/gateway/runtime state**

Run:

```bash
script -q -c 'openclaw plugins inspect fabrica' /dev/null
openclaw gateway status
openclaw fabrica status -w /home/mateus/.openclaw/workspace
```

Expected: the plugin load status, gateway health, and Fabrica workspace status are captured in notes.

- [ ] **Step 2: Record workspace truth and contamination snapshot**

Run:

```bash
cat /home/mateus/.openclaw/workspace/fabrica/projects.json
find /home/mateus/.openclaw/workspace/fabrica/projects -maxdepth 2 -type f | sort
find /home/mateus/.openclaw/workspace/fabrica/bootstrap-sessions -maxdepth 1 -type f | sort
tail -n 60 /home/mateus/.openclaw/workspace/fabrica/log/audit.log
tail -n 60 /home/mateus/.openclaw/logs/commands.log
```

Expected: explicit note of whether live state and on-disk state diverge.

- [ ] **Step 3: Write the Environment Snapshot section**

Write short, factual bullets covering:

```md
- plugin version and load status
- gateway mode and restart state
- `projects.json` state
- count and examples of project directories on disk
- presence or absence of bootstrap sessions
- recent audit/command log signals relevant to hot-path behavior
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md
git commit -m "docs(audit): capture hot path environment snapshot"
```

## Task 3: Audit Telegram Intake And Classification

**Files:**
- Modify: `docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md`
- Inspect: `lib/dispatch/telegram-bootstrap-hook.ts`
- Inspect: `/home/mateus/.openclaw/agents/main/sessions/`

- [ ] **Step 1: Trace the Telegram intake decision tree**

Inspect these code ranges and summarize them in notes:

```bash
sed -n '1280,1560p' lib/dispatch/telegram-bootstrap-hook.ts
sed -n '1,220p' lib/dispatch/telegram-bootstrap-hook.ts
```

Expected: identify the exact branches for `message_received`, `NO_REPLY`, `isBootstrapCandidate`, `isAmbiguousCandidate`, and `classifyAndBootstrap`.

- [ ] **Step 2: Reconstruct the latest real DM flow from session logs**

Run:

```bash
ls -1t /home/mateus/.openclaw/agents/main/sessions | head -n 8
tail -n 120 /home/mateus/.openclaw/agents/main/sessions/<main-session>.jsonl
tail -n 120 /home/mateus/.openclaw/agents/main/sessions/<classification-session>.jsonl
```

Expected: confirm whether inbound DM and classification succeeded, and whether `NO_REPLY` was emitted.

- [ ] **Step 3: Write Checkpoint 1 in the report**

Document:

```md
- source of truth for intake
- observed runtime sequence
- expected sequence
- divergence
- preliminary cause hypothesis
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md
git commit -m "docs(audit): map telegram intake checkpoint"
```

## Task 4: Audit Bootstrap Session Persistence And Handoff

**Files:**
- Modify: `docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md`
- Inspect: `lib/dispatch/telegram-bootstrap-hook.ts`
- Inspect: `lib/dispatch/telegram-bootstrap-session.ts`
- Inspect: `/home/mateus/.openclaw/workspace/fabrica/bootstrap-sessions/`

- [ ] **Step 1: Trace the persistence API and session lifecycle**

Run:

```bash
sed -n '1,260p' lib/dispatch/telegram-bootstrap-session.ts
sed -n '520,1040p' lib/dispatch/telegram-bootstrap-hook.ts
```

Expected: identify where `pending_classify`, `classifying`, `bootstrapping`, `dispatching`, `completed`, `failed`, and `orphaned_repo` are written.

- [ ] **Step 2: Identify writes that happen only in fire-and-forget branches**

Read and record:

```bash
rg -n "classifyAndBootstrap|startFreshBootstrapResume|launchBootstrapResume|enterBootstrapping|upsertTelegramBootstrapSession" lib/dispatch/telegram-bootstrap-hook.ts
```

Expected: a list of async boundaries where state can be lost if the detached path throws or exits before persistence.

- [ ] **Step 3: Compare expected session artifacts with observed disk state**

Run:

```bash
find /home/mateus/.openclaw/workspace/fabrica/bootstrap-sessions -maxdepth 1 -type f | sort
find /home/mateus/.openclaw/workspace/fabrica -type f | rg 'todo-summary|6951571380' -n -S
```

Expected: determine whether the latest bootstrap left no persisted session despite successful classification.

- [ ] **Step 4: Write Checkpoint 2 in the report**

Document:

```md
- session source of truth
- intended status transitions
- observed persistence gap
- atomicity/retry/reentry assessment
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md
git commit -m "docs(audit): map bootstrap persistence checkpoint"
```

## Task 5: Audit Provision/Register Atomicity

**Files:**
- Modify: `docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md`
- Inspect: `lib/tools/admin/project-register.ts`
- Inspect: `lib/intake/index.ts`
- Inspect: `lib/intake/pipeline.ts`
- Inspect: `lib/intake/steps/register.ts`
- Inspect: `lib/telegram/topic-service.ts`

- [ ] **Step 1: Trace the register path end-to-end**

Run:

```bash
sed -n '1,420p' lib/tools/admin/project-register.ts
sed -n '1,240p' lib/intake/steps/register.ts
sed -n '1,260p' lib/intake/pipeline.ts
```

Expected: identify the order of repo creation, topic creation, project registration, and metadata emission.

- [ ] **Step 2: Map all durable writes and external side effects**

Write notes in this exact matrix format:

```md
| Step | External side effect | Internal persistence | Recovery checkpoint | Atomic? |
|------|----------------------|----------------------|---------------------|--------|
```

- [ ] **Step 3: Compare current real residue against the intended atomic model**

Run:

```bash
cat /home/mateus/.openclaw/workspace/fabrica/projects.json
find /home/mateus/.openclaw/workspace/fabrica/projects/todo-summary -maxdepth 2 -type f | sort
gh repo view MestreY0d4-Uninter/todo-summary --json name,url,isPrivate || true
```

Expected: verify whether a directory, repo, or workflow override can exist without a matching registered project.

- [ ] **Step 4: Write Checkpoint 3 in the report**

Document:

```md
- provisioning source of truth
- real side-effect ordering
- orphan/split-brain risks
- whether current behavior is P0 or P1
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md
git commit -m "docs(audit): map register atomicity checkpoint"
```

## Task 6: Audit Project Activation And Dispatch Identity

**Files:**
- Modify: `docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md`
- Inspect: `lib/dispatch/index.ts`
- Inspect: `lib/services/tick.ts`
- Inspect: `lib/tools/worker/work-finish.ts`
- Inspect: `/home/mateus/.openclaw/workspace/fabrica/runtime/lifecycle.json`

- [ ] **Step 1: Trace activation from registered project to first pickup**

Run:

```bash
sed -n '1,280p' lib/dispatch/index.ts
sed -n '1,320p' lib/services/tick.ts
sed -n '1,320p' lib/tools/worker/work-finish.ts
```

Expected: identify the minimal operational path from registered project to dispatched worker.

- [ ] **Step 2: Record current identity model**

Extract and note:

```bash
rg -n "dispatchCycleId|dispatchRunId|sessionKey|slot" lib/dispatch lib/services lib/tools/worker -S
cat /home/mateus/.openclaw/workspace/fabrica/runtime/lifecycle.json
```

Expected: evidence of how Fabrica currently binds work to cycles and sessions.

- [ ] **Step 3: Write Checkpoint 4 in the report**

Document:

```md
- activation checkpoint source of truth
- dispatch identity source of truth
- suspected fragility points
- whether bootstrap/register bugs can bypass or poison dispatch
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md
git commit -m "docs(audit): map activation and dispatch checkpoint"
```

## Task 7: Audit Review/Test Gate Determinism

**Files:**
- Modify: `docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md`
- Inspect: `lib/dispatch/subagent-lifecycle-hook.ts`
- Inspect: `lib/services/heartbeat/passes.ts`
- Inspect: `lib/services/heartbeat/review.ts`
- Inspect: `lib/tools/worker/work-finish.ts`

- [ ] **Step 1: Trace reviewer and tester completion paths**

Run:

```bash
sed -n '1,260p' lib/dispatch/subagent-lifecycle-hook.ts
sed -n '420,620p' lib/services/heartbeat/passes.ts
sed -n '1,240p' lib/services/heartbeat/review.ts
sed -n '1,260p' lib/tools/worker/work-finish.ts
```

Expected: map the exact approval/rejection/fail paths and identify current authoritative completion signals.

- [ ] **Step 2: Record the deterministic contract for rejection loops**

Write notes in this exact form:

```md
- reviewer reject -> expected state:
- tester fail -> expected state:
- tester fail_infra -> expected state:
- merge/close guard behavior:
```

- [ ] **Step 3: Write Checkpoint 5 in the report**

Document:

```md
- gate source of truth
- fallback paths
- authoritative completion mechanism
- current confidence level for deterministic loops
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md
git commit -m "docs(audit): map review and test gates"
```

## Task 8: Audit Recovery, Retry, Dedup, And Reentry

**Files:**
- Modify: `docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md`
- Inspect: `lib/services/heartbeat/index.ts`
- Inspect: `lib/services/heartbeat/passes.ts`
- Inspect: `lib/setup/gateway-lifecycle-hook.ts`
- Inspect: `lib/dispatch/telegram-bootstrap-hook.ts`

- [ ] **Step 1: Trace all hot-path recovery entrypoints**

Run:

```bash
sed -n '1,260p' lib/services/heartbeat/index.ts
sed -n '1,220p' lib/setup/gateway-lifecycle-hook.ts
rg -n "recoverDueTelegramBootstrapSessions|gateway_start|retry|dedup|resume" lib/dispatch lib/services -S
```

Expected: a list of all reentry points that can resume active work.

- [ ] **Step 2: Classify each entrypoint as safe, fragile, or broken**

Write notes in this exact matrix format:

```md
| Entry point | Trigger | Reads from | Writes to | Idempotent? | Confidence |
|-------------|---------|------------|-----------|-------------|------------|
```

- [ ] **Step 3: Write Checkpoint 6 in the report**

Document:

```md
- recovery authority
- retry cadence
- dedup boundaries
- reentry risks that can strand or duplicate work
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md
git commit -m "docs(audit): map recovery and retry behavior"
```

## Task 9: Audit State Contamination

**Files:**
- Modify: `docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md`
- Inspect: `/home/mateus/.openclaw/workspace/fabrica/projects/`
- Inspect: `/home/mateus/.openclaw/workspace/fabrica/projects.json`
- Inspect: `/home/mateus/.openclaw/workspace/fabrica/bootstrap-sessions/`

- [ ] **Step 1: Enumerate live-vs-dead state mismatches**

Run:

```bash
cat /home/mateus/.openclaw/workspace/fabrica/projects.json
find /home/mateus/.openclaw/workspace/fabrica/projects -maxdepth 2 -type f | sort
find /home/mateus/.openclaw/workspace/fabrica/bootstrap-sessions -maxdepth 1 -type f | sort
find /home/mateus/.openclaw/workspace/fabrica/sideband -maxdepth 2 -type f | sort
```

Expected: a list of directories/files/artifacts that remain despite no live registration.

- [ ] **Step 2: Decide whether each residue item is active contamination or passive residue**

Write notes in this exact matrix format:

```md
| Artifact | Present where | Referenced by live state? | Can affect recovery/heartbeat? | Classification |
|----------|----------------|---------------------------|--------------------------------|----------------|
```

- [ ] **Step 3: Write the State Contamination section**

Summarize:

```md
- which residues are benign
- which residues can mislead humans
- which residues can change runtime behavior
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md
git commit -m "docs(audit): classify hot path state contamination"
```

## Task 10: Consolidate Findings And Correction Program

**Files:**
- Modify: `docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md`

- [ ] **Step 1: Convert checkpoint notes into findings**

Write findings under `P0`, `P1`, and `P2` with this exact structure:

```md
### [Severity]-[number]: [short title]
- Unit:
- Evidence:
- Impact:
- Cause hypothesis:
```

- [ ] **Step 2: Write the Intentional Behavior table**

Include these rows at minimum:

```md
- polling-only mode
- heartbeat as recovery path
- Telegram DM suppress / NO_REPLY behavior
- dedicated topic refusal to use General
```

- [ ] **Step 3: Write the correction program**

Use this exact structure:

```md
1. Stabilize bootstrap/session persistence
2. Make register/provision atomic or explicitly recoverable
3. Reconcile activation/dispatch with registered truth
4. Re-verify review/test deterministic loops
5. Clean or quarantine contaminating residue
```

For each item, add:

```md
- why this must happen in that order
- what it should fix
- what evidence should turn green afterward
```

- [ ] **Step 4: Run the self-review checklist**

Run:

```bash
rg -n "TODO|TBD|implement later|fill in details|similar to Task" docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md
```

Expected: no matches

Then manually verify:

```md
- every checkpoint from the spec appears in the report
- each finding has evidence and impact
- intentional behavior is separated from bugs
- the correction program is sequenced
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/audits/2026-04-01-hot-path-operational-audit-report.md
git commit -m "docs(audit): complete hot path operational audit"
```
