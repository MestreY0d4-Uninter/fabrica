# Hot Path Operational Audit Design

Date: 2026-04-01
Status: Proposed
Scope: Fabrica hot path only

## Goal

Audit the current Fabrica hot path as an operational system and identify the concrete bugs that prevent the existing workflow from functioning reliably.

This audit is intentionally not a feature expansion effort. The objective is to make the current plugin operational, deterministic, and recoverable using the capabilities it already has.

## Why This Audit Exists

The current Fabrica build shows a pattern of operational regressions in the core path:

- Telegram DM intake classifies correctly but fails to complete the expected bootstrap handoff
- bootstrap state can disappear or become partially materialized
- external artifacts can be created without consistent internal registration
- recovery logic exists, but its interaction with partial state is not yet trustworthy enough

The risk is not a single isolated bug. The risk is a hot path with split authority, non-atomic state transitions, and recovery that can re-enter from inconsistent checkpoints.

## Scope

This audit covers only the hot path required for Fabrica to operate as an autonomous software factory.

Included:

- Telegram DM intake and bootstrap
- classification handoff and bootstrap session persistence
- project provisioning and registration
- project activation and initial dispatch
- dispatch identity and slot integrity
- review and test gates
- retry, recovery, dedup, and heartbeat behavior on the hot path
- state contamination from test/e2e residues when that residue can affect hot path behavior

Excluded:

- new features
- UX redesigns
- non-essential refactors
- broad platform architecture changes outside the hot path
- changes to OpenClaw

## Platform Assumption

OpenClaw is a fixed platform constraint.

The audit must distinguish between:

- true Fabrica bugs
- intentional Fabrica behavior
- legitimate OpenClaw runtime limitations or optional surfaces

The plugin must adapt to OpenClaw as it exists. The audit must not assume host changes.

## Operational Baseline

For this audit, GitHub webhook delivery is not treated as a required part of the hot path.

The baseline operational mode is:

- Telegram intake works
- Fabrica operates correctly in polling-compatible mode
- heartbeat/recovery can complete the flow without webhook dependency

Webhook support remains valid as an optimization or supplementary integration, but not as a required precondition for the hot path to function.

## Audit Method

The audit treats the hot path as a sequence of persisted checkpoints. For each checkpoint, it asks:

1. What is the source of truth?
2. What side effects happen here?
3. What state is persisted before and after those side effects?
4. What happens if the process crashes between those points?
5. How does recovery resume from this checkpoint?
6. Can stale or external state corrupt this checkpoint?

This is an operational audit, not a code-style review.

## Audit Lanes

### Lane A: Live Flow

This lane examines the active chain of work:

1. DM received
2. bootstrap classified
3. bootstrap persisted
4. repo/topic/project registered
5. issue created
6. dispatch started
7. review/test gate transitions
8. merge/close or return to improve

### Lane B: State Contamination

This lane examines hot-path contamination from stale state:

- orphaned repos/topics/issues
- residual project directories
- mismatch between `projects.json` and on-disk project folders
- stale bootstrap sessions
- discovery/recovery acting on dead state
- audit/log state that hides the real checkpoint

This lane is not the primary cause-finding lane, but it is part of the operational problem because it can distort diagnosis and alter recovery behavior.

## Units Under Audit

### 1. Telegram Intake Unit

Purpose:
- decide whether an inbound Telegram message should trigger Fabrica bootstrap or normal agent behavior

Contract:
- no double response
- no lost valid bootstrap intent
- no false positive bootstrap on ordinary chat

### 2. Bootstrap Session Unit

Purpose:
- persist the state between classification, ack, clarification, registration, and recovery

Contract:
- once a valid bootstrap is accepted, the session must not disappear silently
- if the process stops mid-flight, recovery must have enough persisted state to resume

### 3. Provision/Register Unit

Purpose:
- create external artifacts and register the project internally

Contract:
- registration is either complete and internally consistent, or it leaves an explicit recoverable orphan state
- no split-brain between repo/topic creation and internal project truth

### 4. Project Activation Unit

Purpose:
- create the first actionable issue and transition the project into active execution

Contract:
- a registered project must become operational without manual repair

### 5. Dispatch Identity Unit

Purpose:
- bind project work to the correct cycle, slot, and session

Contract:
- no late event may mutate the wrong dispatch cycle
- no worker completion may be accepted without matching identity

### 6. Review/Test Gate Unit

Purpose:
- gate delivery through reviewer and tester outcomes

Contract:
- approvals advance deterministically
- rejections return the issue to improvement deterministically
- retries do not duplicate or bypass gate outcomes

### 7. Recovery Unit

Purpose:
- resume interrupted work from persisted checkpoints

Contract:
- recovery must neither lose progress nor duplicate side effects
- gateway restart and heartbeat must be safe re-entry points

### 8. State Contamination Unit

Purpose:
- detect whether historical residue can interfere with current flow

Contract:
- dead state must not masquerade as live state
- stale state must not influence pickup, registration, or recovery decisions

## Severity Model

### P0

Prevents autonomous operation of the hot path.

Examples:

- valid Telegram request does not become an active registered project
- review/test gate cannot complete deterministically
- recovery cannot resume an interrupted hot-path operation

### P1

The hot path can work, but may stall, split state, or require manual repair.

Examples:

- repo/topic/project truth diverge
- side effects happen before reliable persistence
- restart or retry can duplicate or strand work

### P2

Noise, degraded observability, or stale residue that does not directly stop the flow but still reduces trust or clarity.

Examples:

- verbose non-critical logs
- stale on-disk artifacts that do not actively mutate live state
- ambiguous audit signals

## Expected Outputs

The audit produces four artifacts:

1. A hot-path map
   - checkpoint-by-checkpoint source of truth, side effects, and recovery behavior

2. A bug table
   - severity
   - unit
   - evidence
   - operational impact
   - cause hypothesis

3. An intentional-behavior table
   - explicit separation of intended fallback/retry/polling behavior from real bugs

4. A correction program
   - sequenced remediation plan focused only on making the existing hot path operational

## Non-Goals

This audit does not seek to:

- redesign Fabrica’s product vision
- add new channels or providers
- introduce new orchestration models
- optimize for elegance before restoring operational correctness

Correctness, determinism, and recoverability come first.

## Recommended Execution Style

Run the audit in this order:

1. Bootstrap and session persistence
2. Provision/register atomicity
3. Activation and dispatch identity
4. Review/test gate determinism
5. Recovery/retry/dedup behavior
6. State contamination and stale residue impact

This order follows the real dependency chain and reduces the chance of patching downstream symptoms before the primary checkpoint is trustworthy.

## Success Criteria

The audit is successful when it produces a defensible explanation of why the current hot path fails, where state is being lost or split, and what corrections are required to make the existing workflow reliable without adding new product scope.
