# Fabrica E2E Stabilization Plan

> Required execution mode: subagent-driven implementation with Kiro read-only review gates.

## Goal

Reach two consecutive clean Telegram E2E passes, in different supported stacks, with no manual operator intervention after launch.

## Execution Model

- Use subagents for independent implementation/investigation slices.
- Use Kiro only for read-only risk review and evidence review.
- Do not stop after local tests if runtime evidence is still dirty.
- Treat broken intermediate projects as disposable validation artifacts.

## Task 1: Finish Telegram Intake Hardening

Files:

- `lib/dispatch/telegram-bootstrap-hook.ts`
- `lib/dispatch/telegram-bootstrap-session.ts`
- `tests/unit/telegram-bootstrap-hook.test.ts`
- `tests/unit/telegram-bootstrap-flow.test.ts`
- `tests/unit/telegram-bootstrap-session.test.ts`

Work:

- finalize DM suppress coverage for real `sessionKey` shapes
- keep `pending_classify` and `classifying` durable
- ensure classify recovery does not silently release active attempts too early
- ensure handoff/cleanup outcomes are explicit and test-covered

Verification:

- focused Telegram bootstrap vitest slice
- runtime revalidation through a fresh Telegram DM launched by the harness

## Task 2: Fail Closed On Bad Greenfield Registration

Files:

- `lib/tools/admin/project-register.ts`
- related intake/scaffold files if needed
- `tests/unit/project-register.test.ts`
- `tests/unit/register-step.test.ts`
- `tests/unit/bootstrap-register-orphaning.test.ts`

Work:

- prevent registration when the canonical repo path does not yet contain the expected stack manifest
- keep greenfield registration aligned with the actual scaffold output path
- ensure bad scaffold/register states fail closed instead of entering a broken environment gate

Verification:

- focused project-register/register-step tests
- fresh runtime validation on a new project, not by repairing old broken projects

## Task 3: Harden Temporary Telegram Harness

Files:

- `/home/mateus/Fabrica/openclaw-telegram-mcp/server.py`
- `/home/mateus/Fabrica/openclaw-telegram-mcp/runner.py`
- `/home/mateus/Fabrica/openclaw-telegram-mcp/tests/test_read.py`
- `/home/mateus/Fabrica/openclaw-telegram-mcp/tests/test_wait.py`
- `/home/mateus/Fabrica/openclaw-telegram-mcp/tests/test_runner.py`

Work:

- keep DM read/send/wait stable
- improve timeout diagnostics so they stay scoped to requested chat/topic/sender
- prevent or serialize concurrent session use so the Telethon SQLite session does not fail with `database is locked`
- keep the runner temporary and decoupled from plugin internals

Verification:

- full harness pytest suite
- real harness usage for DM send/read/topic read

## Task 4: Clean The Validation Surface

Work:

- identify projects created during broken runs that should not be reused
- delete or ignore bad validation artifacts before rerunning fresh projects
- make sure the next E2E is evaluated on a clean path, not on partially broken state

Verification:

- `projects.json`, local repo paths, GitHub repo state, and bootstrap session state agree for the next run

## Task 5: Run E2E Loop Until First Clean Pass

Work:

- pick a supported stack
- launch a fresh project by harness
- observe DM, topic, audit log, repo path, project state, PR, and issue lifecycle
- if any failure occurs, stop and investigate root cause immediately
- apply minimal fix
- rerun with a fresh project

Pass criteria for this task:

- one new project passes the full clean E2E contract

## Task 6: Run E2E Loop Until Second Consecutive Clean Pass In Another Stack

Work:

- choose a different supported stack than Task 5
- rerun the same harness-driven clean validation
- keep the same strict pass criteria

Pass criteria for this task:

- second clean pass occurs
- it is consecutive relative to the previous clean pass
- it uses a different supported stack

## Task 7: Final Verification And Consolidation

Work:

- rerun focused plugin tests for touched slices
- rerun harness test suite
- inspect runtime state for residual leaked/broken validation artifacts
- use Kiro for final read-only evidence review
- only then summarize and commit the stabilization results

## Escalation Rule

If five fresh qualifying E2E attempts still do not yield two consecutive clean passes, stop patching and treat the remaining problem as architectural rather than incidental.
