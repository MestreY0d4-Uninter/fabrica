# Architecture

## Core shape

Fabrica is implemented as a local OpenClaw plugin with the local repository as
its source of truth.

Main areas:

- `lib/intake`
  Intake, target resolution, impact analysis, task creation and triage.
- `lib/github`
  GitHub App auth, webhook ingestion, event store, PR binding, quality gate and
  governance.
- `lib/services`
  Pipeline, heartbeat, queue scans and workflow execution helpers.
- `lib/machines`
  `FabricaRunMachine` and `LifecycleMachine` for explicit state transitions.
- `lib/observability`
  Pino logging, correlation context and OpenTelemetry spans.
- `lib/dispatch`
  DM bootstrap, Telegram topic routing, worker notifications and attachment hooks.
- `lib/telegram`
  Telegram config resolution and topic creation services.
- `defaults`
  Packaged assets and workflow defaults that ship with the plugin.
- `genesis`
  Packaged runtime assets still used by the plugin during the migration away
  from older shell-driven flows.

## Runtime model

Large/xlarge work can be represented as a parent coordination issue plus child
execution issues.

Canonical runtime fields live in `project.issueRuntime[issueId]`:

- `parentIssueId`
- `childIssueIds`
- `dependencyIssueIds`
- `decompositionMode`
- `decompositionStatus`
- `completedChildIssueIds`
- `blockedChildIssueIds`
- `maxParallelChildren`

Operational rules:

- parent issues are coordinator-only and do not enter normal developer execution
- child issues can enter the normal queue with their own level labels and PR flow
- dependency-linked children stay blocked until predecessor execution is complete
- sibling execution is capped by `maxParallelChildren`
- parent rollups are refreshed from child runtime and can auto-close when the
  family is complete

## Environment gate

`lib/test-env` provisions the shared toolchain and the project environment
before dispatching workers in `developer` or `tester` mode.

State model:

`pending -> provisioning -> ready | failed`

Environment contracts are versioned per family using `{family}@v1`
(for example `python@v1` and `node@v1`).

Operational rules:

- Python uses a shared toolchain in `~/.openclaw/toolchains/python`
- Python project environments are materialized locally as `.venv`
- Existing Node repos require a reproducible lockfile before real work starts
- Failure backoff is 60 seconds
- A provisioning state older than 10 minutes is treated as stale and retried
- `dryRun: true` skips environment provisioning entirely and stays side-effect free

## Telegram routing model

New project intake is DM-first. The Fabrica bot accepts a new-project request in
Telegram DM, asks for missing essentials there if needed, and only creates the
project topic when the intake is ready to register. For greenfield projects,
repo provisioning now happens in the TS intake path before registration and
issue creation.

The canonic route identity for Telegram-backed projects is:

`channel=telegram + channelId + messageThreadId`

This avoids collisions between multiple projects inside the same Telegram forum
group. After registration:

- the project topic becomes the primary route for project messages
- follow-ups inside that topic resolve the exact project
- worker notifications and project lifecycle updates publish back to that topic
- ops alerts stay in the separate ops group

The hot path for GitHub is:

`webhook -> event store -> FabricaRun -> Quality Gate -> artifactOfRecord -> done`

Important invariants:

- a cycle never closes with an open canonical PR
- `Done` requires `artifactOfRecord`
- duplicate GitHub deliveries must not duplicate effects
- force-push updates the canonical binding instead of spawning duplicate runs

## Installation model

Fabrica is distributed as a self-contained OpenClaw plugin package.

The supported operator path is:

```bash
openclaw plugins install @mestreyoda/fabrica
```

The installed extension must be loadable in isolation. Fabrica may depend on
OpenClaw only through the plugin host ABI and runtime objects passed by the
host. It must not require manual symlinks, local `npm install`, or host-global
module resolution to load.

External credentials and routes such as GitHub auth, Telegram chat IDs, and
webhook secrets are operational configuration, not installation dependencies.
Fabrica's `doctor` and `setup` flows guide and validate that operational
configuration where applicable.

## Operational notes

- Gateway runtime is managed by the OpenClaw systemd service.
- GitHub webhook ingress is protected by GitHub signature validation inside the
  plugin; the route itself must remain reachable without gateway bearer auth.
- GitHub App and webhook credentials are expected to come from the Fabrica
  plugin config (`openclaw.json`) using direct values and credential file paths;
  legacy env-based fields remain only as compatibility fallback.
- Structured logs and OpenTelemetry spans are emitted by the plugin itself.
- Security validation lives in `openclaw fabrica doctor security --json`.
