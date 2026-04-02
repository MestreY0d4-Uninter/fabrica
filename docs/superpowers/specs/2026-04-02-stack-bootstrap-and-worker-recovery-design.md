# Stack Bootstrap And Worker Recovery Design

Date: 2026-04-02
Status: Proposed
Scope: Fabrica hot path only

## Context

The current hot path exposed two real operational failures in the live `todo-summary` project:

1. Worker liveness and completion were too tightly coupled to plugin tool calls and final result parsing.
   A developer session could be genuinely active, yet look idle to health checks, or remain `running` without producing a canonical final result line.

2. Python QA/tooling bootstrap still relied on ambient host capabilities.
   The live worker hit a real environment failure:
   - `python: command not found`
   - `python3: No module named pip`
   - `python3: No module named ensurepip`

That failure should never have been discovered inside the developer run. The Fabrica plugin should provision what it needs before dispatch, without `sudo`, and only dispatch workers into an environment that is already usable.

The plugin already contains a useful starting point in [`lib/test-env/bootstrap.ts`](/home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica/lib/test-env/bootstrap.ts), including Python bootstrap logic with `uv`, `.venv`, fingerprints, and QA bootstrap tests. This design promotes that capability into an explicit hot-path runtime contract.

## Goals

- Prevent developer/tester dispatch when the project stack environment is not ready.
- Make stack bootstrap a first-class, persistent, idempotent part of Fabrica runtime.
- Remove host dependence for core stack tooling whenever it can be installed without `sudo`.
- Keep worker sessions focused on implementation/review/testing, not bootstrapping toolchains.
- Add recovery for workers that become operationally stuck after observable activity but before canonical completion.
- Preserve deterministic FSM semantics and detailed event-by-event topic timeline.

## Non-Goals

- No OpenClaw changes.
- No broad redesign of Fabrica workflow semantics.
- No attempt to support every stack in this first implementation.
- No background “best effort” bootstrap after dispatch. Environment must be ready first.

## Recommended Approach

Use a `stack bootstrap contract` as a hard pre-dispatch gate, backed by persistent environment state and automatic retry/recovery. Start with Python stacks first, reusing the existing `lib/test-env/bootstrap.ts` logic instead of creating a parallel bootstrap system.

In parallel, strengthen worker completion/recovery so a session that stays `running` but stops producing new transcript activity cannot silently pin the issue in `Doing`.

## Alternatives Considered

### 1. Bootstrap inside the worker

Rejected.

This keeps provisioning mixed into worker execution, recreates the current ambiguity, and makes stuck sessions harder to diagnose.

### 2. Single global Fabrica environment for everything

Rejected.

This is simpler initially, but increases cross-project coupling and dependency drift.

### 3. Stack contract + pre-dispatch environment gate

Recommended.

This is the most robust model and matches the intended plugin vision: Fabrica provisions what it needs, without requiring users to manually patch the host.

## Design

### 1. Stack Bootstrap Contract

Each supported stack exposes a contract that answers:

- What shared toolchain must exist before any project of this stack can run.
- What project-local environment must exist before a worker can be dispatched.
- How readiness is validated.
- Which QA entrypoint is expected for that stack.

Conceptually:

- shared toolchain
  - stack-level, reusable across projects
  - installed without `sudo`
- project environment
  - isolated per project
  - idempotently created/updated
- validation
  - explicit readiness checks, not inference

For Python stacks, the initial contract is:

- shared toolchain:
  - `uv`, installed via official non-`sudo` bootstrap path
- project environment:
  - project-local `.venv`
  - dependencies installed via `uv`
- validation:
  - required binaries resolve from the expected paths
  - `.venv/bin/python` exists
  - QA bootstrap commands can execute in the prepared environment

### 2. Provisioning Model

Provisioning happens in two layers:

- shared stack toolchain
- isolated project environment

This preserves reuse where it is safe and isolation where it matters.

For Python:

- shared stack toolchain lives under Fabrica-controlled user directories
- project-local environment lives with the project or in a Fabrica-managed path bound to that project

The provisioning flow is:

1. resolve project stack
2. ensure shared toolchain for that stack
3. ensure project environment
4. validate readiness
5. only then allow dispatch

### 3. Hard Gate Before Dispatch

Before `dispatch_requested` for at least `developer` and `tester`, Fabrica must verify `environment_ready`.

If not ready:

- do not dispatch
- enter environment bootstrap
- persist bootstrap state
- retry automatically until the environment is ready or recovery is exhausted

This changes the meaning of `Doing` back to what it should mean:

- a worker can meaningfully work now

not:

- a worker was launched and may discover that the host is missing core tooling

### 4. Persistent Environment State

Environment state must be explicit, persisted, and audit-friendly.

Minimum state model:

- `environmentStatus: pending | provisioning | ready | failed`
- `environmentStack`
- `environmentVersion` or contract fingerprint
- `lastProvisionedAt`
- `lastProvisionError`
- `nextProvisionRetryAt`

This state belongs to Fabrica runtime, not to an individual worker session.

### 5. Reuse Existing Python Bootstrap

The current Python bootstrap logic in [`lib/test-env/bootstrap.ts`](/home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica/lib/test-env/bootstrap.ts) should be elevated, not duplicated.

The implementation should:

- extract the stable contract-facing pieces
- make them callable from pre-dispatch orchestration
- keep existing fingerprints and `.venv` reuse behavior
- reuse existing QA bootstrap tests where possible

This avoids creating a second Python bootstrap path with divergent behavior.

### 6. Worker Completion And Recovery

The environment gate prevents one class of failure, but Fabrica still needs stronger recovery when a worker becomes operationally stuck after real activity.

The current real symptom:

- session appears `running`
- transcript stops changing
- no canonical `Work result: ...`
- issue remains in `Doing`

Recommended model:

- `agent_end` and transcript remain primary sources for completion
- transcript/session activity remains the primary liveness source
- PR/branch changes remain auxiliary evidence only

New worker recovery semantics:

- if activity was observed and no final canonical result was produced:
  - enter `inconclusive completion` state
- if session remains live but transcript stops progressing beyond a short inactivity window:
  - attempt automatic completion recovery
- if recovery cannot prove completion and the session remains operationally stuck:
  - mark operational failure explicitly
  - requeue safely
  - notify with a concrete reason

Important distinction:

- `stack bootstrap failure` is an environment-layer problem
- `worker completion failure` is a session/run-layer problem

They must not be collapsed into the same failure mode.

### 7. Failure And Retry Policy

Provisioning failures:

- never dispatch worker first
- retry automatically with backoff
- keep environment state visible
- only surface visible failure after retries are exhausted

Worker completion failures:

- never treat missing final result as immediate quality failure
- try recovery first
- only after exhaustion, requeue with explicit operational reason

Notifications are not the fallback. They are the visible result after fallback/recovery has been exhausted.

### 8. Observability

New audit events should include:

- `environment_bootstrap_started`
- `environment_bootstrap_succeeded`
- `environment_bootstrap_failed`
- `environment_bootstrap_retry_scheduled`
- `environment_ready_confirmed`
- `dispatch_blocked_environment_not_ready`
- `worker_completion_inconclusive`
- `worker_completion_recovery_started`
- `worker_completion_recovery_exhausted`

This is required for operators to distinguish:

- environment not ready
- worker still progressing
- worker operationally stuck
- genuine quality rejection

### 9. Rollout

Rollout should be incremental but under one coherent architecture.

#### Phase 1: Python first

Enable stack bootstrap contract for Python stacks:

- `python-cli`
- other Python families as appropriate

This includes:

- shared `uv` bootstrap without `sudo`
- project `.venv`
- readiness validation
- dispatch gate for developer/tester

#### Phase 2: Worker completion recovery

Add explicit stuck-session recovery for sessions that remain live but stop progressing without canonical completion.

#### Phase 3: Generalize stack contract

Extend the same architecture to additional stack families using the same state model and pre-dispatch gate.

## Data And Control Flow

### Happy path

1. issue becomes eligible for work
2. Fabrica resolves project stack
3. Fabrica checks environment state
4. if not ready, bootstrap runs and validates
5. environment becomes `ready`
6. dispatch occurs
7. worker runs in a prepared environment
8. worker completes with canonical result
9. normal FSM transition applies

### Python bootstrap failure path

1. issue eligible
2. environment not ready
3. Python bootstrap attempts shared toolchain + project `.venv`
4. bootstrap fails
5. environment state records failure
6. retry scheduled
7. no worker dispatched

### Worker stuck path

1. worker starts
2. activity is observed
3. no canonical final result arrives
4. transcript stops progressing
5. completion recovery starts
6. if still unresolved, recovery exhausts
7. issue is safely requeued with explicit operational reason

## Testing Strategy

### Unit

- stack contract resolution
- Python toolchain readiness checks
- environment state transitions
- dispatch gate behavior when environment is not ready
- completion recovery state transitions

### Integration

- Python project on host without `pip` / `ensurepip`
- Fabrica provisions shared `uv`
- Fabrica creates project environment
- developer dispatch only occurs after readiness

### Runtime / Hot Path

Reproduce the live scenario:

- host lacks normal Python packaging tools
- issue becomes eligible
- environment bootstrap happens before dispatch
- worker does not discover missing core tooling mid-run

Also validate:

- live but silent worker session enters recovery instead of pinning `Doing` forever

## Risks

### Risk: duplicated Python bootstrap paths

Mitigation:
- promote the existing `lib/test-env/bootstrap.ts` logic
- do not create a second Python bootstrap implementation

### Risk: environment gate blocks too much work

Mitigation:
- limit first implementation to stacks with explicit contracts
- make state and failure reasons visible

### Risk: recovery becomes too aggressive

Mitigation:
- use transcript/session inactivity windows
- require explicit exhaustion before requeue

## Success Criteria

- Python projects no longer fail inside developer/tester runs due to missing `pip`, `ensurepip`, or equivalent host tooling assumptions.
- Fabrica provisions required stack tooling without `sudo`.
- Developer/tester dispatch is blocked until `environment_ready`.
- Worker sessions that become live-but-silent no longer pin issues indefinitely in `Doing`.
- Audit log clearly distinguishes environment failures from worker completion failures.

