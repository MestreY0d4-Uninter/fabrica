# Hot Path Operational Audit Report

Date: 2026-04-01
Status: Completed

## Scope

This report audits only the Fabrica hot path required for autonomous operation:

- Telegram DM intake and bootstrap
- bootstrap session persistence and retry/recovery
- provision and register flow
- initial project activation and dispatch
- review and test gate determinism
- contamination from stale operational state when it can affect the live flow

OpenClaw is treated as a fixed platform constraint. This report separates plugin bugs from intentional plugin behavior and from host/runtime limitations.

## Executive Summary

- The current first hard break in the live hot path is post-classification Telegram bootstrap handoff, not Telegram intake itself.
- The dominant architectural weakness in the hot path is weak bootstrap session ownership and durability.
- Register/provision still leaks partial side effects before registered project truth exists.
- Dispatch identity is no longer the primary risk area.
- Review/test logic is operationally behind the current ingress/register break, but reviewer completion still has more than one observer.
- The most dangerous contamination vector is stale non-terminal bootstrap session state, not old project directories by themselves.

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

Source of truth:

- dispatch setup in [`dispatch/index.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/dispatch/index.ts)
- queue scan and pickup in [`tick.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/services/tick.ts)
- completion/identity enforcement in [`work-finish.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/tools/worker/work-finish.ts)

Current assessment:

- dispatch identity is substantially more hardened than the bootstrap/register path
- `dispatchTask(...)` uses slot/session/run-cycle fields and guards against stale session reuse
- review/test dispatch now requires a canonical reviewable PR before pickup
- `work_finish` still fails closed when provider validation is uncertain
- the real source of truth for dispatch is project state on disk, not [`runtime/lifecycle.json`](/home/mateus/.openclaw/workspace/fabrica/runtime/lifecycle.json)

Operational reading:

- activation and dispatch are not the primary cause of the current Telegram bootstrap outage
- however, bootstrap/register failure can still poison dispatch indirectly by creating local project residue without a live registered project
- once a project record exists, dispatch itself does not validate Telegram/topic routing; broken notification routing would not block pickup

Preliminary severity:

- no new `P0` found here yet
- current risk is secondary and depends on upstream hot-path corruption
- at most `P2` for observability confusion around lifecycle telemetry

### Checkpoint 5: Review / Test Gates

Source of truth:

- reviewer immediate handling in [`subagent-lifecycle-hook.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/dispatch/subagent-lifecycle-hook.ts)
- reviewer heartbeat fallback in [`passes.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/services/heartbeat/passes.ts)
- provider-side review polling in [`review.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/services/heartbeat/review.ts)
- tester completion in [`work-finish.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/tools/worker/work-finish.ts)

Current assessment:

- reviewer authority is still split across more than one mechanism:
  - agent-end/session parsing
  - reviewer poll pass
  - provider PR review state polling
- tester authority is more coherent because it centers on `work_finish` plus provider validation
- reviewer `work_finish` is no longer part of the hot path and is explicitly blocked
- the intended rejection loops remain clear:
  - reviewer reject -> feedback/improve path
  - tester fail -> improve path
  - tester fail_infra -> retry/retest path

Operational reading:

- review/test gates are no longer the first blocker in the current hot path
- they remain an area of architectural fragility because more than one path can observe or advance reviewer state

Preliminary severity:

- `P1`: reviewer completion still has competing authority paths, even though the most acute earlier stall has already been reduced

### Checkpoint 6: Recovery / Retry / Dedup

Source of truth:

- heartbeat recovery in [`heartbeat/index.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/services/heartbeat/index.ts)
- gateway-start recovery in [`gateway-lifecycle-hook.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/setup/gateway-lifecycle-hook.ts)
- bootstrap recovery in [`telegram-bootstrap-hook.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/dispatch/telegram-bootstrap-hook.ts)

Current assessment:

- heartbeat and gateway-start recovery are safe right now only because [`bootstrap-sessions/`](/home/mateus/.openclaw/workspace/fabrica/bootstrap-sessions) is empty
- the most dangerous active contamination source is not old project directories but stale non-terminal bootstrap session files
- a stale `bootstrapping` or `dispatching` session can both:
  - suppress new Telegram replies
  - trigger automatic recovery/replay

Operational reading:

- the recovery model is workable only if bootstrap session persistence is trustworthy
- until then, recovery is fragile because it depends on a session model that can disappear, be overwritten, or regress

Preliminary severity:

- `P1`: recovery entrypoints are structurally fragile because they depend on weak session ownership

## State Contamination

Preliminary observation:

- Fabrica’s live registration truth is empty, but the workspace still contains many project directories and at least one partial `todo-summary` project override.
- This means stale on-disk state is already proven to diverge from live project truth.
- The contamination lane must determine which of these residues are only diagnostic noise and which can still influence heartbeat, discovery, registration, or recovery.

Refined classification:

- active contamination:
  - any non-terminal file in [`bootstrap-sessions/`](/home/mateus/.openclaw/workspace/fabrica/bootstrap-sessions), because that can suppress Telegram replies and trigger recovery
- passive residue:
  - old project directories under [`projects/`](/home/mateus/.openclaw/workspace/fabrica/projects)
  - sideband scaffold files under [`sideband/`](/home/mateus/.openclaw/workspace/fabrica/sideband)
  - rotated audit logs and backup files

Current nuance:

- passive residue still harms diagnosis and trust
- but the most operationally dangerous contamination vector is session state, not old directories by themselves

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

### P1-4: Reviewer completion still has competing authority paths
- Unit: Review/Test Gate Unit
- Evidence:
  - reviewer decision text is parsed from session output as the canonical agent-review signal
  - reviewer poll pass can also transition based on the same session later
  - provider-side review polling in [`review.ts`](/home/mateus/Fabrica/.worktrees/release-integration/fabrica/lib/services/heartbeat/review.ts) can still advance review from PR state, including merged PRs satisfying approval checks
- Impact:
  - reviewer-text authority is not exclusive, which keeps recovery and gate reasoning more complex than the tester path
- Cause hypothesis:
  - the plugin still supports a mixed model of agent-review completion and provider-side review state recovery

### P2

### P2-1: Workspace residue substantially obscures the real live state
- Unit: State Contamination Unit
- Evidence:
  - [`projects.json`](/home/mateus/.openclaw/workspace/fabrica/projects.json) is empty while many old project directories remain on disk
  - old audit and sideband artifacts remain alongside current state
- Impact:
  - slows diagnosis and makes operators misread what is actually live
- Cause hypothesis:
  - cleanup of test/e2e residue is not enforced as part of operational reset

### P2-2: Lifecycle telemetry can be mistaken for dispatch truth
- Unit: Project Activation / Dispatch Unit
- Evidence:
  - [`runtime/lifecycle.json`](/home/mateus/.openclaw/workspace/fabrica/runtime/lifecycle.json) only carries coarse service state
  - dispatch/pickup logic actually reads project state and slot/runtime fields from the project store
- Impact:
  - operators can chase the wrong artifact during diagnosis
- Cause hypothesis:
  - lifecycle telemetry is useful for service health but not clearly distinguished from project/dispatch truth

## Intentional Behavior

- `NO_REPLY` in active Telegram bootstrap handling is intentional. The plugin explicitly suppresses the normal agent reply while bootstrap is in progress.
- `polling-only mode` for GitHub remains valid baseline behavior when webhook secret is absent.
- dedicated-topic refusal is intentional: autonomous DM bootstrap should not fall back to Telegram `General`.
- heartbeat and `gateway_start` recovery are intentional mechanisms, but their correctness depends on durable bootstrap session truth.
- reviewer text parsing is intentional as the canonical agent-review contract, but provider-side review polling still exists as a separate recovery path.

## Correction Program

1. Stabilize bootstrap session persistence and handoff.
- Why first:
  this is the first `P0` break in the current live flow
- What it should fix:
  valid classified DMs must always leave a durable, recoverable `bootstrapping` checkpoint before the first ack boundary
- Green signal:
  classified bootstrap attempt always creates a visible session record and emits the ack

2. Make bootstrap attempt ownership stronger than bare `conversationId`.
- Why second:
  current recovery and retry correctness depends on preventing silent overwrite/regression of session state
- What it should fix:
  later DMs, retries, or stale resumptions must not erase or regress the current bootstrap attempt
- Green signal:
  repeated DMs and restart/retry paths preserve or explicitly supersede the right bootstrap attempt

3. Make register/provision side effects atomic or explicitly recoverable.
- Why third:
  current split-brain begins before `projects.json` becomes true
- What it should fix:
  no more `workflow.yaml`/repo/topic residue without corresponding project truth or explicit orphan checkpoint
- Green signal:
  either the project is registered completely or the orphan state is explicit and recoverable

4. Reconcile recovery entrypoints with session truth.
- Why fourth:
  heartbeat and gateway-start recovery are only as safe as the session model they consume
- What it should fix:
  stale resumers must not regress terminal state or replay the wrong attempt
- Green signal:
  restart and heartbeat resume only valid, current checkpoints

5. Re-verify review/test deterministic loops after the ingress/register path is stable.
- Why fifth:
  these gates are not the first blocker right now, but reviewer authority still has multiple observers
- What it should fix:
  ensure no downstream loop reintroduces nondeterminism once project creation is working again
- Green signal:
  reviewer/tester approval and rejection paths advance exactly once and to the expected states

6. Quarantine or clean passive residue after hot-path correctness is restored.
- Why last:
  residue is distorting diagnosis, but it is not the first blocking failure
- What it should fix:
  reduce operator confusion and prevent false positives during later audits
- Green signal:
  workspace on-disk state matches live registration truth closely enough for reliable operations
