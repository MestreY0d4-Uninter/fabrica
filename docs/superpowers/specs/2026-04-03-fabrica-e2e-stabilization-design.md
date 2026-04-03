# Fabrica E2E Stabilization Design

Date: 2026-04-03
Status: Approved for autonomous execution

## Goal

Stabilize the Fabrica Telegram bootstrap and validation flow until it reliably completes real end-to-end project creation and delivery without manual operator intervention.

The success bar for this stabilization round is:

- two consecutive new projects
- in different supported stacks
- sent through Telegram DM by the temporary validation harness
- completed end-to-end without manual intervention
- with no DM leak into the main OpenClaw session
- with no bad project registration against an empty or non-materialized repo

“Consecutive” is strict here:

- after the final stabilization loop begins, the last two qualifying E2E runs must both pass
- no failed qualifying E2E run may exist between those two passes

## Scope

This round is intentionally limited to consolidating behavior that already exists.

Included:

- Telegram DM intake durability and suppression
- classify and bootstrap handoff/recovery
- greenfield scaffold/register correctness
- environment gate correctness for newly scaffolded projects
- temporary Telegram validation harness hardening
- repeated real E2E validation and correction loops

Not included:

- new Fabrica features
- permanent MCP productization
- new workflow phases
- broad OpenClaw runtime redesign

## Definitions

### Canonical Repo Path

The canonical repo path is the local filesystem repository path persisted in Fabrica project state and used by registration, environment bootstrap, and dispatch.

For this round it must mean:

- the local path stored in `projects.json`
- the same local path used by greenfield scaffold output
- the same local path checked by environment bootstrap

If those differ, the project is not considered validly scaffolded.

### Clear Project DM

A Telegram DM is “clear” only when it contains all of the following:

- a project-creation cue such as `build`, `create`, `crie`, `construa`, or equivalent
- a software target cue such as `cli`, `app`, `api`, `tool`, or `project`
- enough information to derive a reasonable project slug directly or deterministically from explicit `called`, `named`, or `chamado` forms

Anything else remains eligible for classifier-assisted handling.

## Current Failure Classes

The current system is no longer failing in a single place. Validation exposed several linked failure classes:

1. Telegram DM bootstrap can still leak into the generic OpenClaw main session if suppress logic misses the real DM session key shape or tool-call path.
2. Early bootstrap classify/handoff can still be lost or cleaned up incorrectly when timing, ownership, or recovery paths disagree.
3. Greenfield registration can succeed before the canonical repo path contains the actual scaffolded project, producing a registered project whose environment gate then fails correctly.
4. The temporary Telegram harness is good enough for single-lane operation, but still needs robustness for reliable repeated E2E validation.

## Design Principles

1. Runtime evidence wins over theory.
2. Kiro is read-only review, never implementation authority.
3. A failed E2E run is not noise; it is evidence and must either be explained or fixed.
4. No greenfield project may register unless the canonical repo path already proves the expected stack scaffold exists.
5. Telegram bootstrap suppression must be preventive, not merely diagnostic.
6. Validation must be automated enough that the operator is no longer the transport layer.

## Workstreams

### A. Telegram Intake Hardening

The Telegram DM bootstrap path remains the primary control-plane risk.

This workstream hardens:

- canonical Telegram conversation identity
- deterministic project-name extraction for clear project DMs
- durable `pending_classify` and `classifying`
- explicit classify/handoff outcomes
- `before_prompt_build` and `before_tool_call` suppression for active Telegram DM bootstrap sessions
- no silent cleanup for early bootstrap ownership or classify recovery paths

Target outcome:

- a clear project DM is either durably owned by Fabrica or explicitly released
- it never silently escapes into generic main-session execution

### B. Greenfield Scaffold/Register Correctness

The plugin must stop registering projects against canonical repo paths that do not yet contain the expected stack scaffold.

This workstream hardens:

- canonical repo path derivation
- shell/TypeScript scaffold path alignment
- registration preconditions for stack manifests
- failure-closed behavior when greenfield scaffold has not materialized at the canonical repo path

Target outcome:

- no newly registered project can enter the environment gate with only the bootstrap `README.md` commit

### C. Temporary Telegram Validation Harness

The harness is a temporary operator replacement, not a product feature.

It must be strong enough to:

- send Telegram DM prompts
- send commands such as `/reset` and `/restart`
- read DMs and project topics
- wait for expected responses
- produce diagnostics that stay scoped to the requested conversation/topic

The harness may add a lightweight runner, but must remain decoupled from the Fabrica plugin.

For this round, “lightweight runner” means:

- no imports from Fabrica plugin code
- no dependence on Fabrica internal files for primary control flow
- only Telegram-facing operations plus optional external verification against GitHub/OpenClaw CLI outputs
- no long-lived service or permanent operator subsystem

Target outcome:

- validation no longer depends on manual Telegram operation

### D. Repeated E2E Stabilization Loop

Implementation is not done when tests pass locally. The loop only ends when real Telegram E2E runs pass the approved success bar.

The loop is:

1. run a real E2E project through the harness
2. detect whether it leaks, stalls, mis-registers, or fails downstream
3. investigate root cause from runtime evidence
4. fix the root cause
5. rerun a fresh E2E project
6. repeat until the success bar is met

The loop is bounded:

- if five fresh qualifying E2E attempts still do not produce two consecutive clean passes, stop and escalate as an architectural issue instead of continuing indefinite patching

## E2E Validation Contract

An E2E run counts as clean only if all of the following are true:

- the DM prompt is acknowledged by Fabrica
- the DM does not trigger generic OpenClaw assistant work on the same request
- the project is registered once
- the canonical repo path contains the expected stack manifest and scaffold content
- environment bootstrap reaches a measurable ready state:
  - Node: canonical repo path contains `package.json`
  - Python: canonical repo path contains `pyproject.toml` or `requirements.txt`
  - and Fabrica’s environment gate no longer reports `environment_not_ready` for the initial developer dispatch
- developer/reviewer/tester progress through the normal workflow
- the issue closes and the PR merges
- no manual repo surgery or manual Telegram intervention is needed mid-run

A qualifying E2E run must also finish within a bounded validation window:

- soft expectation: under 30 minutes
- hard limit for counting as a pass in this round: under 90 minutes

## Final Success Gate

This stabilization round is complete only when:

- one new project passes cleanly in one supported stack
- then a second new project passes cleanly in a different supported stack
- both are driven by the temporary Telegram harness
- both require no manual operator intervention after launch
- the two clean passes are consecutive under the loop rule above

Recommended stack pair:

- one Python stack
- one Node stack

## Kiro Role

Kiro remains part of the process, but only as a read-only second opinion.

Kiro may review:

- implementation risk
- coverage gaps
- E2E evidence sufficiency
- whether a rerun is justified

Kiro may not:

- edit files
- author patches
- override runtime evidence

## Risks And Controls

### Risk: false confidence from local tests

Control:

- every major fix must be validated by a real Telegram E2E loop, not just unit tests

### Risk: repeated contamination from already-bad projects

Control:

- broken projects created during stabilization may be discarded and rerun fresh
- they are evidence, not assets to preserve

### Risk: harness instability obscures plugin bugs

Control:

- keep harness improvements minimal and directly tied to validation reliability
- avoid adding plugin-specific coupling

### Risk: partial fixes hide deeper hot-path bugs

Control:

- use subagents for independent investigation
- use Kiro read-only review before major rerun decisions
- treat unexplained E2E behavior as unresolved, not “probably fine”

## Exit Rule

Do not declare Fabrica stable at the end of this round unless the final success gate is satisfied.
