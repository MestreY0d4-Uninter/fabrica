# Hot Path Operational Audit Report

Date: 2026-04-01
Status: In Progress

## Scope

This report audits only the Fabrica hot path required for autonomous operation:

- Telegram DM intake and bootstrap
- bootstrap session persistence and retry/recovery
- provision and register flow
- initial project activation and dispatch
- review and test gate determinism
- contamination from stale operational state when it can affect the live flow

OpenClaw is treated as a fixed platform constraint. This report separates plugin bugs from intentional plugin behavior and from host/runtime limitations.

## Environment Snapshot

- Plugin load status: [`fabrica`](/home/mateus/.openclaw/extensions/fabrica/dist/index.js) is `loaded` via `openclaw plugins inspect fabrica`.
- Installed plugin version: `0.2.13`.
- Gateway status: systemd-managed gateway is running and RPC probe is `ok`, but `openclaw gateway status` reports service hygiene issues unrelated to the immediate Fabrica hot path:
  - embedded `OPENCLAW_GATEWAY_TOKEN`
  - version-manager Node binary in the service `PATH`
  - non-minimal `PATH`
- Fabrica workspace status: `openclaw fabrica status -w /home/mateus/.openclaw/workspace` reports `No projects registered.`
- Registered project truth: [`projects.json`](/home/mateus/.openclaw/workspace/fabrica/projects.json) contains no live projects and `_seq: 1058`.
- On-disk contamination: [`/home/mateus/.openclaw/workspace/fabrica/projects/`](/home/mateus/.openclaw/workspace/fabrica/projects) still contains at least `13` historical project directories plus a partial `todo-summary` directory, despite no registered projects in [`projects.json`](/home/mateus/.openclaw/workspace/fabrica/projects.json).
- Bootstrap session state: [`bootstrap-sessions/`](/home/mateus/.openclaw/workspace/fabrica/bootstrap-sessions) is currently empty, even after the latest Telegram bootstrap attempt.
- Audit log signal: [`audit.log`](/home/mateus/.openclaw/workspace/fabrica/log/audit.log) still shows old heartbeat scans over `11` discovered projects and a prior `pipeline_orphaned_artifacts` event for `todo-summary`.
- Command log signal: [`commands.log`](/home/mateus/.openclaw/logs/commands.log) shows repeated Telegram `reset` actions for `agent:main:telegram:direct:6951571380`, including the latest one at `2026-04-01T15:06:25.940Z`.

## Live Flow Map

### Checkpoint 1: Telegram Intake

Source of truth:

- inbound Telegram message routed through the `message_received` hook in [`telegram-bootstrap-hook.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/dispatch/telegram-bootstrap-hook.ts)
- main-session transcript in [`243ca3ad-cd8c-4afc-9c7f-29db74773d08.jsonl`](/home/mateus/.openclaw/agents/main/sessions/243ca3ad-cd8c-4afc-9c7f-29db74773d08.jsonl)
- classification-session transcript in [`ab13919f-eb7d-41a4-a7b1-70ed2d3586ca.jsonl`](/home/mateus/.openclaw/agents/main/sessions/ab13919f-eb7d-41a4-a7b1-70ed2d3586ca.jsonl)

Observed runtime sequence in the latest `todo-summary` attempt:

1. The Telegram DM reached the main agent session.
2. The main agent emitted `NO_REPLY`.
3. The classifier subagent ran successfully and returned:
   - `intent: create_project`
   - `confidence: 0.99`
   - `stackHint: python-cli`
   - `projectSlug: todo-summary`
4. No user-facing DM ack was sent after that.
5. No bootstrap session remained on disk.

Expected sequence:

1. DM enters `message_received`
2. Fabrica suppresses normal agent output with `NO_REPLY`
3. classification returns valid bootstrap intent
4. bootstrap session persists and advances into `bootstrapping`
5. immediate DM ack is sent

Divergence:

- intake and classification both worked
- the regression happens after successful classification and before the first bootstrap ack

Assessment:

- `NO_REPLY` is intentional behavior, not a bug
- the intake unit is partially healthy
- the first hot-path break is the post-classification handoff, not the classification itself

Preliminary severity:

- `P0`: a valid Telegram request does not become a live bootstrap flow even though the system recognizes it as one

### Checkpoint 2: Bootstrap Session Persistence

Source of truth:

- bootstrap session persistence API in [`telegram-bootstrap-session.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/dispatch/telegram-bootstrap-session.ts)
- handoff and resume paths in [`telegram-bootstrap-hook.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/dispatch/telegram-bootstrap-hook.ts)
- runtime disk state in [`bootstrap-sessions/`](/home/mateus/.openclaw/workspace/fabrica/bootstrap-sessions)

Intended transition:

- `pending_classify` -> `classifying` -> `bootstrapping` -> later `dispatching` / `completed` / `failed`

Observed state in the latest run:

- no file exists in [`bootstrap-sessions/`](/home/mateus/.openclaw/workspace/fabrica/bootstrap-sessions)
- no `6951571380`-scoped artifact exists anywhere in the Fabrica workspace
- the only fresh residue is [`projects/todo-summary/workflow.yaml`](/home/mateus/.openclaw/workspace/fabrica/projects/todo-summary/workflow.yaml)

Implications:

- a valid classified bootstrap can disappear without leaving a recoverable bootstrap session
- the system already proves non-atomic behavior, because some downstream side effect for `todo-summary` was materialized on disk while the main session truth was lost

Risk shape:

- the handoff uses detached async paths such as `classifyAndBootstrap(...)`, `startFreshBootstrapResume(...)`, and `launchBootstrapResume(...)`
- if one of those paths throws or returns before durable session persistence, the bootstrap can vanish after a successful classification
- empty `bootstrap-sessions/` means gateway restart and heartbeat have nothing authoritative to resume from
- session storage is keyed only by `conversationId`, so later DMs from the same Telegram chat can overwrite or delete the same bootstrap file instead of creating an attempt-scoped record
- recovery concurrency is protected only in-memory through `activeBootstrapResumes`, which is not a durable lease across process restart or overlap
- stale resumers can potentially regress terminal session states because retry logic treats only `failed` as terminal when deciding whether to requeue

Preliminary severity:

- `P0`: the bootstrap session unit fails its core contract
- `P1`: partial state can still leak to disk, which creates split-brain contamination

### Checkpoint 3: Provision / Register

Source of truth:

- pipeline ordering in [`pipeline.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/intake/pipeline.ts)
- registration side effects in [`project-register.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/tools/admin/project-register.ts)
- cleanup behavior in [`artifact-cleanup.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/intake/lib/artifact-cleanup.ts)

Observed order of side effects:

1. repo provisioning happens before register
2. autonomous workflow override can be materialized on disk before topic creation
3. topic creation can happen before `projects.json` write
4. `projects.json` write happens only later in the register path

Concrete evidence:

- [`pipeline.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/intake/pipeline.ts) runs `provisionRepoStep` before `registerStep`
- [`project-register.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/tools/admin/project-register.ts) materializes the project workflow override before topic creation and before `writeProjects(...)`
- current residue proves that this ordering leaks state:
  - [`projects/todo-summary/workflow.yaml`](/home/mateus/.openclaw/workspace/fabrica/projects/todo-summary/workflow.yaml) exists
  - [`projects.json`](/home/mateus/.openclaw/workspace/fabrica/projects.json) has no `todo-summary`
  - the scaffold sideband for `todo-summary` still records a created repo/local clone in [`genesis-b6b6a4aabdefc7152fd53023-scaffold-7201cb4959070e469a9716da9901f673-EZPcJ8.json`](/home/mateus/.openclaw/workspace/fabrica/sideband/genesis-b6b6a4aabdefc7152fd53023-scaffold-7201cb4959070e469a9716da9901f673-EZPcJ8.json)

Atomicity assessment:

- `registerProject(...)` is not atomic across its own side effects
- there are at least three split-brain windows:
  - after workflow override, before topic creation
  - after topic creation, before `projects.json`
  - after `projects.json`, before later pipeline completion

Orphan handling assessment:

- cleanup support is partial
- [`artifact-cleanup.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/intake/lib/artifact-cleanup.ts) has compensators for `github_repo` and `github_issue`, but not for `forum_topic`
- local workflow override directories are also not represented as cleanup-managed artifacts

Preliminary severity:

- `P1`: register/provision leaks state before internal truth is durable
- this can escalate into `P0` when the split-brain blocks recovery or causes a valid project request to disappear operationally

### Checkpoint 4: Project Activation / Dispatch

Pending.

### Checkpoint 5: Review / Test Gates

Pending.

### Checkpoint 6: Recovery / Retry / Dedup

Pending.

## State Contamination

Preliminary observation:

- Fabrica’s live registration truth is empty, but the workspace still contains many project directories and at least one partial `todo-summary` project override.
- This means stale on-disk state is already proven to diverge from live project truth.
- The contamination lane must determine which of these residues are only diagnostic noise and which can still influence heartbeat, discovery, registration, or recovery.

## Findings

### P0

### P0-1: Valid Telegram bootstrap can die after successful classification
- Unit: Telegram Intake Unit / Bootstrap Session Unit
- Evidence:
  - main Telegram session emitted `NO_REPLY` as expected in [`243ca3ad-cd8c-4afc-9c7f-29db74773d08.jsonl`](/home/mateus/.openclaw/agents/main/sessions/243ca3ad-cd8c-4afc-9c7f-29db74773d08.jsonl)
  - classifier returned `create_project` with high confidence in [`ab13919f-eb7d-41a4-a7b1-70ed2d3586ca.jsonl`](/home/mateus/.openclaw/agents/main/sessions/ab13919f-eb7d-41a4-a7b1-70ed2d3586ca.jsonl)
  - no file exists in [`bootstrap-sessions/`](/home/mateus/.openclaw/workspace/fabrica/bootstrap-sessions) after the attempt
  - no DM ack was sent
- Impact:
  - the hot path fails before the user gets confirmation and before recovery has durable state to resume from
- Cause hypothesis:
  - the post-classification handoff moved to detached resume logic, but the durable transition into `bootstrapping` is not reliably happening before the first side-effect boundary

### P0-2: Bootstrap recovery has no authoritative session to resume in the latest path
- Unit: Recovery Unit
- Evidence:
  - the latest `todo-summary` request left no bootstrap session on disk
  - recovery logic depends on persisted bootstrap sessions in [`telegram-bootstrap-hook.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/dispatch/telegram-bootstrap-hook.ts)
- Impact:
  - gateway restart and heartbeat cannot heal the current failure mode
- Cause hypothesis:
  - bootstrap persistence is failing before the recovery entrypoints gain ownership of the flow

### P1

### P1-1: Register/provision order leaks partial local state before project truth exists
- Unit: Provision/Register Unit
- Evidence:
  - [`project-register.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/tools/admin/project-register.ts) writes workflow overrides before topic creation and before `writeProjects(...)`
  - [`projects/todo-summary/workflow.yaml`](/home/mateus/.openclaw/workspace/fabrica/projects/todo-summary/workflow.yaml) exists while [`projects.json`](/home/mateus/.openclaw/workspace/fabrica/projects.json) is empty
- Impact:
  - split-brain between on-disk project materialization and registered project truth
- Cause hypothesis:
  - non-atomic register implementation with side effects staged before durable internal registration

### P1-2: Orphan cleanup is incomplete for Telegram/bootstrap artifacts
- Unit: Provision/Register Unit / Recovery Unit
- Evidence:
  - [`artifact-cleanup.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/intake/lib/artifact-cleanup.ts) only auto-cleans `github_repo` and `github_issue`
  - `forum_topic` falls through to manual cleanup
  - workflow overrides are not modeled as cleanup artifacts
- Impact:
  - partial failures can strand external and local state that recovery cannot fully reconcile
- Cause hypothesis:
  - artifact compensation does not cover all side effects created by the bootstrap path

### P1-3: Bootstrap session storage is too weak for overlapping retries and repeated DMs
- Unit: Bootstrap Session Unit / Recovery Unit
- Evidence:
  - session files are keyed by `conversationId`, not by attempt id
  - the same file can be deleted on fail-open classification paths
  - `activeBootstrapResumes` is only in-memory
  - session writes are read-modify-write without a durable compare-and-swap guard
- Impact:
  - later retries or later DMs can erase, overwrite, or regress an in-flight bootstrap checkpoint
- Cause hypothesis:
  - bootstrap state model is conversation-scoped, but the operational flow really needs attempt-scoped durability or stronger write ownership

### P2

Pending.

## Intentional Behavior

Pending.

## Correction Program

Pending.
