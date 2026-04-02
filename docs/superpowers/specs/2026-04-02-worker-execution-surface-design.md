# Worker Execution Surface Design

Date: 2026-04-02
Status: Proposed
Scope: Fabrica hot path worker contract

## Problem

The current hot path still allows Fabrica workers to behave like general-purpose OpenClaw agents instead of bounded executors.

That mismatch is now a proven operational bug.

In the live `log-summarizer` cycle:

- the project bootstrap and environment gate recovered successfully
- the developer worker started and showed real activity
- the worker then read the global `coding-agent` skill and launched a nested `codex exec --full-auto ...` background process
- the nested process died or disappeared without producing a canonical Fabrica completion
- the parent Fabrica worker remained `running` without further progress, PR creation, or `Work result: ...`

This is incompatible with the core intent of Fabrica:

- autonomous
- modular
- reusable
- operationally predictable
- high-quality software production with explicit control over state transitions

The hot path cannot depend on workers having unrestricted access to global OpenClaw skills or meta-orchestration capabilities.

## Goal

Define a worker execution contract that preserves useful host capabilities while preventing Fabrica workers from becoming sub-orchestrators.

The solution must:

- keep workers effective inside their own project worktree
- prevent recursive delegation and planning/meta-skills in the hot path
- preserve deterministic completion and recovery
- align with Fabrica's existing completion model (`agent_end` + canonical final result lines)

## Non-Goals

- redesign the whole OpenClaw skill system
- build a separate sandbox runtime outside OpenClaw
- remove all reuse of host capabilities
- change Fabrica's project FSM beyond what is needed to enforce worker execution boundaries

## Design Principles

1. A Fabrica worker is an executor, not a general agent.
2. Reuse is good only when it preserves operational predictability.
3. Prompt-only controls are not sufficient.
4. The hot path must fail closed on execution-contract violations.
5. Recovery is mandatory, but recovery is not the primary control plane.

## Capability Model

Workers will use a three-class capability model.

### Allowed

Capabilities that help the worker execute directly in the assigned worktree:

- read and write project files
- run stack tooling locally
- run build, lint, test, QA commands
- use git locally
- use GitHub CLI for the project workflow when the role contract expects it

### Forbidden

Capabilities that change the orchestration topology:

- `coding-agent`
- `brainstorming`
- `writing-plans`
- delegation or spawn of other coding agents
- any skill/tool flow that turns the worker into a new planner/orchestrator

### Conditional

Capabilities that may be useful later but are not part of the default hot path:

- external search/research helpers
- broad documentation helpers
- diagnostic helpers beyond the project execution contract

Conditional capabilities should default to unavailable in hot path workers unless explicitly approved by role-specific policy.

## Role Policy

### Developer

Allowed:

- direct implementation work
- tests, QA, branch, commit, push, PR creation
- stack tooling

Forbidden:

- nested coding agents
- planning skills
- recursive delegation

### Reviewer

Allowed:

- diff inspection
- PR and issue inspection
- decision output

Forbidden:

- implementation execution
- nested coding agents
- planning skills

### Tester

Allowed:

- QA execution
- validation against PR and branch artifacts

Forbidden:

- nested coding agents
- planning or implementation delegation

### Architect

Architect may eventually allow a broader read-only surface than other roles, but in the hot path it should still follow the same anti-recursion rule.

## Enforcement Layers

The solution should not rely on a single control.

### Layer 1: Prompt Contract

Role prompts and worker context must explicitly say:

- execute directly in the assigned worktree
- do not delegate to another coding agent
- do not use planning/meta-skills
- Fabrica completion depends on the worker's own canonical final result line

This is clarity, not enforcement.

### Layer 2: Surface Filtering

Workers should not see global skills that are outside the Fabrica hot path contract.

At minimum, Fabrica workers should not inherit:

- `coding-agent`
- `brainstorming`
- `writing-plans`
- similar orchestration/meta-execution skills

This is the primary preventive control.

### Layer 3: Runtime Detection and Recovery

Even with filtering and prompt hardening, Fabrica must detect execution-contract violations.

Signals include:

- transcript shows use of forbidden skill names
- transcript shows nested coding-agent launches
- transcript shows meta-planning behavior instead of project execution
- parent worker remains alive while the nested subprocess dies or disappears

When detected:

1. mark the run as `invalid_execution_path`
2. do not accept it as valid progress
3. allow a short recovery window in case the worker resumes and completes canonically
4. if no recovery occurs, release the slot and requeue safely

## Recovery Semantics

Execution-contract violation is not the same as review rejection and not the same as environment failure.

It is an operational failure of the worker run.

Recommended path:

- short recovery window after detection
- if canonical completion appears, continue normally
- if not, mark recovery exhausted
- notify the project topic with a short operational explanation
- requeue for a fresh worker cycle

This keeps the FSM semantics clean:

- quality rejection stays in review/test
- operational violation stays in worker execution/recovery

## Observability

Add explicit auditability for this class of problem.

Recommended events:

- `worker_execution_contract_violation`
- `worker_meta_delegation_detected`
- `worker_execution_recovery_started`
- `worker_execution_recovery_exhausted`
- `worker_execution_requeued`

Topic notifications should remain brief and event-shaped, for example:

- worker violated execution contract
- nested delegation is not allowed
- fresh developer cycle has been queued

## Risks

### Over-restricting workers

If filtering is too broad, a legitimate worker capability may disappear.

Mitigation:

- start with a narrow blacklist of known meta-skills
- keep direct execution tools available
- apply policy by role, not only globally

### False positives in violation detection

Mitigation:

- only treat strong evidence as violation
- prefer concrete transcript/tool evidence over vague heuristics

### Recovery windows that are too long or too short

Mitigation:

- keep the first implementation short and auditable
- tune later from real telemetry

## Recommended Implementation Order

1. filter hot path worker skill surface
2. harden role prompts and worker context
3. add runtime detection for forbidden meta-delegation
4. add requeue-safe recovery and topic notification

## Recommendation

The recommended solution is a layered worker execution contract:

- allowlist-like execution surface for workers
- explicit prohibition of meta-skills and nested coding agents
- runtime detection plus short recovery window
- fail-closed requeue if recovery does not succeed

This is the most robust option because it preserves useful host reuse while restoring Fabrica's control over the hot path.
