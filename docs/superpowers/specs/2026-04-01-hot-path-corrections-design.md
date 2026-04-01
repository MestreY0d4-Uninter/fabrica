# Hot Path Corrections Design

Date: 2026-04-01
Status: Proposed

## Goal

Restore the Fabrica hot path to a reliably operational state without expanding product scope or changing OpenClaw. The work must only harden and reconcile the behaviors that already exist: Telegram DM bootstrap, durable project registration, recovery, and downstream review/test loops.

## Problem Statement

The operational audit identified one live `P0` break and several directly related `P1` weaknesses:

- valid Telegram bootstrap requests can die after successful classification and before the first DM acknowledgment
- bootstrap session truth is too weak to support retries, restart recovery, and repeated DMs safely
- register/provision can leak partial side effects before durable project truth exists
- reviewer completion still has more than one observer path, though this is not the first blocker
- workspace residue and noisy lifecycle surfaces make diagnosis harder than it should be

The design objective is not to add new capabilities. It is to make the current autonomous flow deterministic, recoverable, and operationally legible.

## Non-Goals

- no OpenClaw changes
- no redesign of Fabrica into a new architecture
- no new external integrations
- no expansion of intake semantics beyond the current Telegram/bootstrap model
- no new review/test product behavior beyond making the existing loops deterministic

## Constraints

- OpenClaw is a fixed host platform and may expose partial or uneven runtime surfaces across hook contexts
- polling-only GitHub mode remains a valid baseline
- Telegram DM bootstrap, project forum topics, and ops surfaces remain intentionally separate
- the release should prefer local, bounded changes over sweeping rewrites

## Design Principles

- durable truth before side effects
- one active bootstrap attempt must have one authoritative owner
- recovery must reuse the same state machine as the live path, not a parallel interpretation
- partial failures must become explicit recoverable checkpoints, not silent residue
- dispatch/review/test should only be touched where needed to preserve determinism downstream

## Approaches Considered

### 1. Minimal bootstrap patch

Patch only the post-classification handoff that currently drops the session.

Why not chosen:

- it does not address weak session ownership
- it leaves register/provision split-brain intact
- it would likely move the failure one step further instead of stabilizing the hot path

### 2. Focused hot-path hardening

Harden the current flow end-to-end where the audit found real breaks:

- bootstrap persistence
- attempt ownership
- register/provision atomicity or explicit orphaning
- recovery entrypoint alignment
- review/test downstream verification
- CLI log calibration

Why chosen:

- it fixes the actual `P0`
- it covers the adjacent `P1`s that would otherwise immediately re-break the flow
- it stays within current product scope

### 3. Full intake/recovery rewrite

Replace bootstrap/register/recovery with a new queue or orchestration model.

Why not chosen:

- too large for the current goal
- unnecessary before the existing model is made correct

## Design

### 1. Durable Bootstrap Handoff

`classifying` must mean only one thing: waiting for classification.

Once a Telegram DM is successfully classified as a bootstrap candidate:

1. the session must be durably persisted immediately
2. the status must advance to `bootstrapping`
3. only then may the plugin attempt user-facing or external side effects

The first acknowledgment DM is part of the `bootstrapping` step, not the classification step. This ensures that a successful classifier result can never disappear without leaving recoverable state.

The bootstrap path should be represented as a single resumable routine whose steps are checkpointed through session state rather than inferred from detached async calls. The same routine should be used both for the live path and for retries/recovery.

### 2. Stronger Bootstrap Attempt Ownership

The current conversation-scoped session model is too weak for repeated DMs and recovery overlap.

The corrected model should preserve the conversation relationship but strengthen ownership with an attempt identity or equivalent monotonic ownership marker so that:

- a newer attempt can explicitly supersede an older one
- an older resume cannot silently overwrite a newer live attempt
- recovery logic can distinguish current work from stale work

This does not require a whole new subsystem. It requires durable write ownership semantics stronger than `conversationId` alone.

Recovery leases must be durable enough that restart recovery, heartbeat recovery, and inline bootstrap progress all operate on the same current attempt.

### 3. Register / Provision Truth Model

Provision and registration currently leak state in the wrong order.

The corrected model must ensure one of two outcomes:

- the project becomes durably registered and routable
- or the system leaves an explicit recoverable orphan checkpoint that owns any partial side effects

Implicit residue such as local workflow overrides, sideband scaffold artifacts, or forum topics without corresponding durable truth is not acceptable.

This can be achieved in either of two acceptable ways:

- move durable internal registration earlier and gate later side effects behind it
- or keep the current order but represent each side effect in an explicit artifact/checkpoint ledger that recovery can reconcile

The implementation should choose the smaller change that eliminates silent split-brain.

### 4. Recovery Unification

Gateway-start recovery, heartbeat recovery, and inline resume must all consume the same bootstrap truth.

Recovery rules:

- only current recoverable bootstrap attempts may resume
- terminal sessions must not regress
- retries must update explicit attempt metadata such as error, retry schedule, and ownership
- recovery must not depend on inference from unrelated residue in `projects/` or `sideband/`

The recovery path should not be a second interpretation of bootstrap state. It should call the same step executor as the live path.

### 5. Downstream Determinism

Dispatch is not the current primary break, but the correction must preserve downstream guarantees.

Required alignment:

- dispatch identity remains keyed to current project state, not coarse lifecycle snapshots
- reviewer rejection returns work to improve exactly once
- tester failure returns work to improve exactly once
- tester infrastructure failure remains retry/retest oriented

Reviewer completion should continue to treat reviewer text as the canonical agent-review contract. Provider-side polling may remain as a recovery observer only if it cannot compete with or reinterpret current reviewer truth.

### 6. Operational Legibility

The correction should reduce diagnostic confusion without broad cleanup work.

This includes:

- reducing Fabrica registration/webhook noise in CLI flows while preserving useful gateway logs
- clarifying which on-disk artifacts are authoritative and which are only diagnostic
- quarantining or cleaning passive residue only after hot-path correctness is restored

## Data and State Model

The corrected bootstrap session needs, at minimum, durable fields for:

- conversation identity
- current attempt ownership
- status
- retry metadata
- latest classification result
- current checkpoint within bootstrapping
- latest error

The design does not require a brand-new storage backend. It requires the existing storage to represent enough state to make retries and supersession safe.

Provision/register artifacts that can survive partial failure must either:

- be represented in session/project truth
- or be explicitly classified as orphaned artifacts pending cleanup/recovery

## Error Handling

Transient failures after classification must not drop the bootstrap session. They should:

- keep the session in a recoverable non-terminal state
- record the failure
- schedule retry
- allow heartbeat or gateway-start recovery to continue the same attempt

Terminal failures should be reserved for real contract errors such as impossible configuration or unrecoverable invariants, not normal transport instability.

## Testing Strategy

The correction should be test-driven around the exact failures already seen in production.

Required coverage:

- classification success always persists a recoverable bootstrap session before first ack/send
- repeated DMs and retries do not regress or overwrite the live bootstrap attempt incorrectly
- restart/heartbeat recovery resumes the current bootstrap attempt without duplicating or regressing state
- register/provision no longer leaves silent split-brain residue
- reviewer/test rejection loops still return work to the expected states
- CLI execution paths no longer print Fabrica registration/webhook noise by default

The final validation must include a real Telegram DM bootstrap test against the local gateway after deployment of the corrected plugin.

## Rollout

Recommended order:

1. bootstrap durability and ownership
2. register/provision truth alignment
3. recovery unification
4. downstream review/test verification
5. operational log calibration
6. real Telegram validation

## Success Criteria

- a valid Telegram bootstrap request always creates durable recoverable state
- the first user-visible acknowledgment is restored
- restart or heartbeat can resume in-flight bootstrap work correctly
- no silent `workflow.yaml`/repo/topic split-brain remains in the corrected path
- downstream review/test loops still behave deterministically
- Fabrica no longer pollutes normal CLI flows with avoidable registration noise
