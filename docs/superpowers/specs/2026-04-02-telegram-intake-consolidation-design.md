# Telegram Intake Consolidation Design

Date: 2026-04-02
Branch: `release/hot-path-release`

## Goal

Consolidate the existing Telegram DM intake so clear project requests reliably enter Fabrica's durable bootstrap flow, even when classification is delayed, aborted, or returned late.

This work does not add a new feature. It hardens and reconciles behavior that the plugin already claims to support:

- Telegram DM bootstrap
- deterministic project intent detection
- LLM-assisted classification/enrichment
- bootstrap session persistence
- bootstrap recovery
- Telegram reply suppression during bootstrap

After implementation, validate the original `csv-peek` prompt end-to-end with rate limits no longer in effect.

## Non-Goals

- redesign the whole Telegram architecture
- add new user-facing bootstrap capabilities
- add new stacks or scaffold behavior
- replace the current classify model/provider
- move bootstrap to a different channel or agent architecture

## Problem Statement

The current intake can lose a valid project request at the edge:

1. the DM is correctly identified as bootstrap-related
2. the main session is suppressed with `NO_REPLY`
3. the classifier subagent may actually succeed
4. but the hook can treat the classify step as failed too early
5. transient session state is removed or never handed off durably
6. no project is registered and no durable bootstrap state remains

Observed in the `csv-peek` incident:

- the classifier session returned `create_project`, `python-cli`, `csv-peek`
- the plugin logged `classify waitForRun status=timeout`
- the bootstrap session directory stayed empty afterward
- no project registration or pipeline audit event followed

This means the root issue is not only provider/rate limit instability. The intake path is structurally too eager to fail open and too weak in the handoff between classification and durable bootstrap.

## Design Principles

1. Clear project intent must be more important than short-lived classify timing.
2. Bootstrap session state must become the primary truth from the first plausible project signal.
3. LLM classification should enrich or disambiguate, not authorize the existence of bootstrap state.
4. No early-path transition may fail silently.
5. Telegram identity must be canonical across intake, suppression, and recovery.
6. Cleanup must be explicit and auditable, not an accidental side effect of reading state.

## Proposed Approach

### 1. Deterministic-first intake

Keep the current layered intake model, but strengthen the order of operations:

- use deterministic candidate detection first
- use deterministic stack detection first
- use deterministic slug/name extraction first for obvious free-text forms such as:
  - `called <slug>`
  - `named <slug>`
  - `chamado <slug>`
- only use LLM classification when intent, stack, or project name still needs help

This preserves current capabilities while reducing unnecessary LLM dependence in obvious project requests.

### 2. Durable bootstrap from the first plausible project signal

When a DM is a plausible project request, create or retain a durable bootstrap session immediately.

Implications:

- `pending_classify` and `classifying` are durable bootstrap states
- classify timeout or abort does not delete bootstrap state
- a late classifier result is reconciled into the same bootstrap attempt
- a clear project request does not fall back to ordinary chat just because `waitForRun()` returned early

### 3. Classification is asynchronous and reconciliable

Classification remains part of the existing intake, but it is no longer a synchronous gate in the critical path.

Behavior:

- the hook may start classify work
- if the immediate wait succeeds, apply the result normally
- if the wait times out or aborts, mark the bootstrap attempt as pending classification reconciliation
- recovery or a later reconciliation step reads the eventual classify result and advances the bootstrap

This turns "late classify result" from an error into a supported normal case.

### 4. Explicit handoff outcomes

The transition from classification to bootstrap resume must stop being silent.

Any handoff attempt must end in one of these explicit results:

- `started`
- `already_active`
- `superseded`
- `failed_to_start`

The caller must inspect that result and log or persist it. `null` or equivalent silent no-op behavior is not acceptable in this path.

### 5. Canonical Telegram conversation identity

All bootstrap reads, writes, suppression checks, and recovery operations must use one canonical conversation identity helper.

This must cover:

- `message_received`
- `before_prompt_build`
- `message_sending`
- recovery and replay paths

The design goal is to eliminate split-brain behavior between raw chat IDs and prefixed `telegram:<id>` keys.

### 6. Explicit cleanup and expiry

Do not rely on read-time silent deletion for early bootstrap states.

Instead:

- expiry remains allowed
- but expiry must be handled by an explicit cleanup/recovery decision
- the decision must leave audit evidence

This avoids invisible loss of state and makes bootstrap lifecycle explainable.

## State Model

The existing state model remains, but its semantics are tightened:

- `pending_classify`
  - plausible project request persisted
  - classify not started or not yet durably reconciled

- `classifying`
  - classify in progress or awaiting eventual result reconciliation

- `bootstrapping`
  - enough information exists to proceed with bootstrap handoff

- `clarifying`
  - more user input is required

- `failed`
  - explicit terminal failure with reason

- `completed`
  - project registered and handoff completed

Important semantic change:

- `pending_classify` and `classifying` are not disposable just because a short wait ended

## Error Handling

### Classify timeout or abort

Current behavior:

- may log a warning
- may delete the transient session
- may effectively lose the request

New behavior:

- keep the bootstrap attempt
- record classify wait failure as an intermediate condition
- schedule or allow reconciliation
- do not release the request back to ordinary chat

### Late classify result

Current behavior:

- may arrive after the hook already failed open

New behavior:

- reconcile the result into the existing bootstrap attempt
- continue to `bootstrapping` or `clarifying`

### Handoff already active

Current behavior:

- may silently no-op

New behavior:

- explicit `already_active`
- caller records or audits the outcome
- no state disappearance

### Truly invalid project request

Still allowed to fail, but explicitly:

- record why the bootstrap failed
- do not leave suppress state ambiguous

## Observability

Add minimal early-path auditability only where it explains real state transitions.

Recommended events:

- `telegram_bootstrap_candidate_received`
- `telegram_bootstrap_pending_classify`
- `telegram_bootstrap_classifying`
- `telegram_bootstrap_classify_wait_aborted`
- `telegram_bootstrap_classify_result_reconciled`
- `telegram_bootstrap_handoff_started`
- `telegram_bootstrap_handoff_already_active`
- `telegram_bootstrap_handoff_failed_to_start`
- `telegram_bootstrap_cleanup_expired`

This is not a logging expansion for its own sake. It is the minimum needed to explain why a valid request did or did not become a project.

## Kiro Review Lane

Kiro is part of the process as a second opinion only.

Rules:

- Kiro receives enough context to review the problem independently
- Kiro must never edit code
- Kiro must never be asked to write patches
- Kiro is used for:
  - design review
  - risk review
  - root-cause second opinion
  - verification review

Operational preference:

- use `kiro-cli chat --no-interactive` via a controlled runner
- prefer `systemd-run --user` for isolated execution when helpful
- keep Fabrica runtime evidence as the primary source of truth

## Testing Strategy

Required regressions:

1. classify wait timeout followed by eventual successful classifier result
   - bootstrap session remains durable
   - request does not disappear

2. clear request with free-text naming
   - example: `Build a small Python CLI tool called csv-peek`
   - deterministic path extracts slug/name without requiring classify for existence

3. handoff already active
   - no silent loss
   - explicit outcome recorded

4. canonical identity across hooks
   - same Telegram conversation suppresses and resumes correctly across all hook paths

5. cleanup/expiry
   - expired transient state is cleaned explicitly
   - cleanup is auditable

## Validation Criteria

The change is only correct if all of the following are true:

1. A clear project DM never disappears because classify returned late.
2. A classify timeout/abort no longer causes bootstrap state loss.
3. The handoff from classify to bootstrap cannot silently no-op.
4. Telegram identity is consistent across intake and suppress paths.
5. A real prompt such as `csv-peek` can be revalidated end-to-end after implementation.

## Recommended Scope

This correction should be implemented as a consolidation of the existing Telegram intake path, not as a broad rewrite.

That means:

- keep the current DM bootstrap feature
- keep the existing classify capability
- keep the existing session model
- harden ordering, durability, identity, cleanup, and observability

This is the smallest change set that materially reduces the current intake risk.
