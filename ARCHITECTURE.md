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
Those are validated through Fabrica's `doctor` and `setup` flows.

## Operational notes

- Gateway runtime is managed by the OpenClaw systemd service.
- GitHub webhook ingress is protected by GitHub signature validation inside the
  plugin; the route itself must remain reachable without gateway bearer auth.
- GitHub App and webhook credentials are expected to come from the Fabrica
  plugin config (`openclaw.json`) using direct values and credential file paths;
  legacy env-based fields remain only as compatibility fallback.
- Structured logs and OpenTelemetry spans are emitted by the plugin itself.
- Security validation lives in `openclaw fabrica doctor security --json`.
