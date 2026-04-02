# Hot-Path Event Timeline Design

Date: 2026-04-01
Branch: `release/hot-path-release`
Scope: Hot-path operational corrections only. No OpenClaw changes.

## Context

The Fabrica hot path is now operational enough to advance real work through `developer -> reviewer -> To Improve`, but the Telegram topic timeline is still unreliable as an operator surface.

Three failures were observed in the live `todo-summary` project:

1. Reviewer rejection happened, but no Telegram message was emitted for the rejection.
2. Developer completion and review-queued messages were delivered late, making the timeline appear out of order.
3. After the rejection, the next developer cycle appears stuck in `Doing`, with an active slot and no visible progress.

This spec defines a correction program for the operator-facing event timeline and the related stuck-cycle recovery behavior. It does not expand Fabrica with new capabilities. It only makes the existing flow faithful, durable, and observable.

## Goals

- Preserve a detailed Telegram timeline with one message per relevant operational event.
- Make the timeline semantically accurate: each message must represent a real transition or real dispatch for a specific cycle.
- Surface reviewer agent outcomes in the topic, including a short reason for rejection.
- Prevent late delivery from an old cycle from appearing as a fresh event in a newer cycle.
- Recover safely when a developer cycle is effectively dead but still marked active.

## Non-Goals

- Do not reduce the timeline to summaries.
- Do not redesign Fabrica's FSM.
- Do not change OpenClaw behavior.
- Do not add new product features outside the current hot path.

## Observed Evidence

### Reviewer rejection exists but is silent

The reviewer session for `todo-summary` ended with a canonical rejection and explicit rationale:

- correctness bug in prefix detection in `src/todo_summary/main.py`
- missing tests for exact prefix semantics in `tests/test_main.py`
- final line: `Review result: REJECT`

The live transition was recorded in audit as `reviewer_session_transition`, but no Telegram notification was emitted for the rejection path.

### Timeline drift came from delayed delivery, not from FSM mis-order alone

In the live audit log:

- `workerComplete` and `reviewNeeded` were queued after developer completion
- both failed with `runCommand is required when runtime is not available`
- after the runtime forwarding fix, they were delivered later
- by then the reviewer had already been dispatched and had already rejected

This means the topic showed a stale developer-cycle message after a newer review event had already happened.

### Current developer cycle appears stuck

The current `todo-summary` state shows:

- issue `#1` labeled `Doing`
- developer slot active in `projects.json`
- no later workflow transition after the post-reject redispatch
- PR `#2` still open and `UNSTABLE`
- GitHub Actions `qa` failing with `uv is required to bootstrap project-local QA dependencies`
- the OpenClaw session registry points to a `sessionFile` path that does not exist on disk for the currently active developer slot

This is enough evidence to treat stuck-cycle recovery as part of the same hot-path correction.

## Design

### 1. Timeline remains event-detailed

The Telegram topic continues to receive a detailed timeline, not summaries. The canonical event set becomes:

- `workerStart`
- `workerComplete`
- `reviewQueued`
- `reviewRejected`
- `reviewApproved`
- `testQueued`
- `testFailed`
- `testPassed`
- `redispatchStarted`

This keeps operator visibility high while making each message correspond to a single operational fact.

### 2. Each event has one authority point

Each notification must be emitted from the subsystem that actually applies the corresponding event:

- `dispatch/index.ts`
  - `workerStart`
- `pipeline.ts`
  - `workerComplete`
  - `reviewQueued`
  - `testQueued`
- `reviewer-completion.ts`
  - `reviewRejected`
  - `reviewApproved`
- tester completion path
  - `testFailed`
  - `testPassed`
- recovery paths
  - only notify when they actually apply a new transition or new redispatch

No parallel observer path may invent a second notification for the same semantic event.

### 3. Reviewer reject/approve must notify

`reviewer-completion.ts` currently transitions the issue and audits the result, but does not notify the project topic.

It must start emitting:

- `reviewRejected`
- `reviewApproved`

For `reviewRejected`, the message must include a short rationale extracted from the reviewer final message. The rationale should be concise and operator-facing, not a full transcript dump.

The extraction rule should be conservative:

- prefer the final assistant message that contains the canonical `Review result:` line
- extract the short blocking findings summary from that same message
- if a stable short summary cannot be extracted, still send the reject event without inventing details

### 4. Event identity must be cycle-aware

Notification dedupe cannot use only `project + issue + eventType`, because that collapses valid new cycles and allows stale deliveries to look current.

Every outbox event key must include cycle identity:

- `projectSlug`
- `issueId`
- `eventType`
- `dispatchCycleId` or `dispatchRunId`
- when relevant, the terminal result (`REJECT`, `APPROVE`, `DONE`, `FAIL`, etc.)

This ensures:

- a real new cycle can emit its own legitimate events
- a delayed delivery from an older cycle is still recognizable as older
- recovery can resend only the undelivered event for that exact cycle

### 5. Delivery order must follow semantic order within a cycle

Within one cycle:

- `workerComplete` must be emitted only after completion has actually been applied
- `reviewQueued` must be emitted only after the issue is really in the review phase
- `reviewRejected` or `reviewApproved` must be emitted only after the review transition is applied

`workerStart` may still be emitted early for responsiveness, but it must carry the same cycle identity as the dispatch that created it.

The important rule is not "strict global ordering across all async deliveries". The rule is:

- no event may be emitted before its authoritative state transition exists
- stale cycle events must not masquerade as current-cycle events

### 6. Recovery must not speak for no-op paths

Recovery and heartbeat may:

- retry delivery of an already-created event for the same cycle
- emit a new event if they apply a real transition or real redispatch

Recovery and heartbeat may not:

- emit a fresh timeline event for a no-op
- emit a duplicate semantic event for a cycle that already advanced beyond it

This keeps the topic truthful.

### 7. Stuck developer recovery becomes explicit

The current `todo-summary` cycle shows that "slot active" is not sufficient proof of a live developer run.

The recovery model must distinguish:

- live session still working
- dead session with active slot
- completed work blocked only by external CI
- PR open but no active worker truly alive

This requires one practical hardening:

- if the registered session points to a nonexistent session file or otherwise cannot prove liveness, the cycle must not remain indefinitely trusted as active

The recovery policy should then decide one of these explicit outcomes:

- keep running because the worker is genuinely alive
- clear the stale slot and redispatch developer with fresh context
- move back to `To Improve` when that is the safe queue for re-entry

The system must not stay forever in `Doing` with no trustworthy live session.

## File-Level Change Map

- `lib/services/reviewer-completion.ts`
  - emit `reviewRejected` / `reviewApproved`
  - carry short reviewer rationale on reject
- `lib/services/reviewer-session.ts`
  - expose conservative reviewer rationale extraction helper
- `lib/dispatch/notify.ts`
  - add new event types and human-readable message builders
- `lib/dispatch/notification-outbox.ts`
  - strengthen dedupe key with cycle-aware identity
- `lib/services/pipeline.ts`
  - ensure cycle-aware identity is passed into `workerComplete` / `reviewQueued`
- recovery/liveness slice
  - harden stuck developer detection against nonexistent or non-proving sessions

## Error Handling

- If reviewer rationale extraction fails, still emit `reviewRejected` without the reason.
- If event delivery fails, only retry the exact undelivered event for that exact cycle.
- If cycle identity is missing, fail closed: do not fabricate a dedupe key that could collide across cycles.
- If liveness cannot be proven and the session artifact is gone, prefer safe recovery over indefinite trust.

## Testing

Required tests:

- reviewer rejection emits Telegram notification
- reviewer rejection includes short reason when extractable
- reviewer approval emits Telegram notification
- outbox dedupe allows the same event type in a new cycle but not twice in the same cycle
- delayed delivery from an old cycle does not suppress or replace current-cycle events
- `workerComplete -> reviewQueued -> reviewerStart` remains ordered by applied state, not optimistic pre-send
- stale active developer slot with nonexistent or non-proving session is recoverable and does not stay forever in `Doing`

Required real validation:

- run live Telegram project flow again
- confirm topic shows:
  - developer start
  - developer complete
  - review queued
  - reviewer start
  - reviewer reject with short reason
  - developer redispatch
- confirm no stale prior-cycle completion message appears after the reject event

## Risks

- reviewer rationale extraction can become too brittle if it tries to over-parse free text
  - mitigation: conservative extraction, optional field
- dedupe key change can accidentally suppress legitimate retries or duplicate valid new-cycle events
  - mitigation: key explicitly tied to cycle identity
- stuck recovery can become too aggressive and interrupt a genuinely live worker
  - mitigation: only recover when liveness is not provable, not merely when progress is slow

## Success Criteria

- reviewer agent decisions are visible in the Telegram topic
- rejection reason is visible in short form when available
- topic timeline remains event-detailed
- old-cycle notifications no longer arrive as if they belonged to the current cycle
- stale active developer cycles do not remain indefinitely stuck in `Doing`
