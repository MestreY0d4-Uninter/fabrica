# Emergency coordinator runbook (P0 containment)

This runbook is intentionally limited to the P0 containment phase. Fabrica's
GitHub issue/PR state remains the projection; no durable coordinator ledger is
enabled by this change.

## Dispatch safety

1. A dispatch must pass `sessions.patch` and an active-session confirmation before
   the issue label is moved to an active state.
2. If confirmation fails or the gateway session registry is unavailable, dispatch
   fails closed. The slot/label rollback path leaves the issue retryable in its
   queue; it must never be announced as active.
3. The confirmation error is `gateway_session_not_confirmed`; use that exact value
   when searching `fabrica/audit.log`.

## Recovery

Run the normal heartbeat health pass first. It fences stale dispatch identity by
checking the slot/runtime dispatch cycle and run IDs before applying a repair.
Only the current generation may be repaired; old session events are ignored.

If a repair cannot prove the issue, session, and worktree identity, stop and
quarantine the run for human review. Do not delete unknown sessions or worktrees,
force-push, disable sandboxing, or bypass evidence gates.

## Evidence gate

A worker completion is not a deployment or merge proof. Require the canonical PR,
QA evidence, and deployment evidence required by the workflow before closing an
issue. Missing evidence means requeue/refine, not success.

## Remaining P1 work

A durable SQLite run/lease/session/outbox/artifact/QA/deploy ledger, explicit
`BOOTSTRAP_READY` versus runtime acceptance, lease epochs, sequence CAS fencing,
reconciliation/quarantine CLI, and emergency-lane automation are not included in
this containment patch and must be implemented as a separately reviewed phase.
