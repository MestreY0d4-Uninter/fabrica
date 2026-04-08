# Fabrica

[![npm version](https://img.shields.io/npm/v/@mestreyoda/fabrica)](https://www.npmjs.com/package/@mestreyoda/fabrica)
[![license](https://img.shields.io/npm/l/@mestreyoda/fabrica)](./LICENSE)

> Autonomous software engineering pipeline for OpenClaw.

Fabrica turns a natural-language project description into a fully executed engineering workflow: intake, specification, issue decomposition, development, code review, testing, and merge. It orchestrates AI agents as specialized workers (developers, reviewers, testers) through a deterministic finite state machine, with repair-oriented recovery when runtime signals or stack environments are incomplete.

## How it works

```
  Human idea (text)
        |
        v
  [ Intake & Spec ]  ←  classify → interview → generate-spec
        |
        v
  [ Issue decomposition ]  ←  GitHub issues created
        |
        v
  [ developer ]  →  opens PR
        |
        v
  [ reviewer ]   →  approves or requests changes
        |
        v
  [ tester ]     →  runs QA, posts evidence
        |
        v
  [ merge ]      →  PR merged, issue closed
        |
        v
       done
```

The heartbeat ticks every 60 seconds. On each tick, Fabrica alternates between a **repair** pass (fixes stale states, retries incomplete completion signals, and reconciles broken runtime ownership) and a **triage** pass (advances work that is ready to move). No human intervention is required after the initial project description.

## Features

- **Zero-intervention pipeline** — from idea to merged PR without manual steps
- **Deterministic FSM** — every transition is explicit; states are `planning → todo → doing → toReview → toTest → done` (+ `refining`, `toImprove`, `rejected`)
- **Pluggable AI workers** — each role (developer, reviewer, tester, architect) maps to a configurable model and level
- **Polling-first GitHub integration** — uses `gh` CLI for all GitHub operations; no webhook infrastructure or GitHub App required
- **Telegram bootstrap** (optional) — describe a new project via DM; Fabrica asks clarifying questions and provisions the repo automatically
- **Parent/child large-work orchestration** — large initiatives can become one coordinator issue plus execution-ready child issues with dependency-aware scheduling and automatic parent rollups
- **Stack-aware environment gate** — developer and tester dispatch only start after the project stack environment is provisioned and marked ready
- **Lifecycle-driven worker completion** — reviewer, developer, tester, and architect completion resolve from agent lifecycle plus canonical result lines, not from fragile tool availability assumptions
- **Detailed event timeline** — project topics receive explicit worker start, completion, review, rejection, and recovery events with cycle-aware dedupe
- **Programmatic genesis** — trigger the full pipeline from a CLI script without Telegram
- **Observability built-in** — audit log, metrics subcommand, heartbeat health checks, and OpenTelemetry tracing
- **Safe-by-default** — conflict detection, mutex-guarded heartbeat, stack bootstrap retries, session validation, completion recovery, and label integrity guards

## Requirements

- [OpenClaw](https://openclaw.dev) runtime >= 2026.3.13
- OpenClaw gateway operational on the local machine (default port 18789)
- Git (for repository operations and local development)
- Node.js 22+ with npm/npx available
- `gh` CLI authenticated to GitHub (required for repo, issue, PR, and comment operations)
- A GitHub organization or personal account where repositories will be created
- For Python stacks, Fabrica provisions `uv` and project-local environments itself without `sudo`
- (Optional) Telegram bot token and group chat IDs for DM bootstrap and notifications

### Host prerequisites vs project provisioning

Fabrica provisions a lot inside each project runtime, but it is not a universal host bootstrapper.

What should already exist on the machine:
- OpenClaw installed and working
- Node/npm usable
- Git usable
- `gh auth` completed with permissions to create repositories, issues, PRs, and comments

What Fabrica provisions at project/runtime level:
- Python `uv` bootstrapping when needed
- project-local `.venv` for Python stacks
- project scaffolding and QA contract files
- stack-specific environment preparation before developer/tester pickup

## Installation

### Via npm (recommended)

```bash
openclaw plugins install @mestreyoda/fabrica
```

That install should be enough for OpenClaw to load Fabrica immediately, without
manual remediation.

### Via GitHub clone

```bash
git clone https://github.com/MestreY0d4-Uninter/fabrica ~/fabrica
openclaw plugins install -l ~/fabrica
```

After installation, verify the plugin loaded correctly:

```bash
openclaw plugins inspect fabrica
```

## Loadability vs operational readiness

- **Loadable:** the plugin installs and OpenClaw can load it immediately.
- **Operational:** Fabrica has the GitHub, Telegram, and optional webhook
  configuration needed for your workflow.

`openclaw plugins inspect fabrica` is the loadability check after install.
`openclaw fabrica doctor` runs once the plugin is loaded and checks the
operational/workspace state, then tells you what is still missing.

## Quick start

This is the minimum recommended path to get Fabrica working end-to-end with the official product flow.

**1. Authenticate GitHub CLI**:

```bash
gh auth status || gh auth login
```

Fabrica uses authenticated `gh` CLI for GitHub operations in the default setup.
Make sure the authenticated identity can create repositories, issues, PRs, and comments in the target account or organization.

**2. Install Fabrica**:

```bash
openclaw plugins install @mestreyoda/fabrica
```

The plugin should load immediately after install, without manual remediation.

**3. Confirm loadability**:

```bash
openclaw plugins inspect fabrica
```

If OpenClaw warns that `plugins.allow` is empty and non-bundled plugins may auto-load, that is a host trust-policy warning, not a Fabrica install failure. Fabrica can be installed and loadable while the OpenClaw operator still has to decide whether to keep open discovery or set an explicit trusted plugin list in `plugins.allow`.

**4. Configure Fabrica for a workspace**:

```bash
openclaw fabrica doctor workspace --workspace /path/to/workspace
openclaw fabrica setup --workspace /path/to/workspace --new-agent fabrica
```

Use `openclaw fabrica setup --agent <id>` if you already have an agent.

When the official Telegram DM bootstrap flow is configured (`bootstrapDmEnabled=true`
plus `projectsForumChatId`), `openclaw fabrica setup` also prepares the dedicated
internal `genesis` agent automatically.

**5. Configure Telegram for the official Fabrica flow**:

The official flow is:
- Telegram DM with the bot for new-project intake
- one Telegram forum group for project topics/timelines

At minimum, when DM bootstrap is enabled, set:
- `plugins.entries.fabrica.config.telegram.bootstrapDmEnabled=true`
- `plugins.entries.fabrica.config.telegram.projectsForumChatId=<YOUR_PROJECTS_FORUM_CHAT_ID>`

If `projectsForumChatId` is missing while DM bootstrap is enabled, Fabrica can accept the DM but will fail when it needs to create the project topic.

Tip: if you export `FABRICA_PROJECTS_CHANNEL_ID` before running `openclaw fabrica setup`, Fabrica now copies that value into `plugins.entries.fabrica.config.telegram.projectsForumChatId` automatically during setup.

Example:

```bash
export FABRICA_PROJECTS_CHANNEL_ID="<YOUR_PROJECTS_FORUM_CHAT_ID>"
openclaw fabrica setup --workspace /path/to/workspace --new-agent fabrica
```

**6. Validate operational readiness**:

```bash
openclaw plugins inspect fabrica
openclaw fabrica doctor workspace --workspace /path/to/workspace
```

**Environment provisioning note**:

Developer and tester pickup pass through a stack environment gate. Fabrica
prepares the project environment before dispatching real work, instead of
finding missing dependencies inside a live worker run.

For Python projects, this includes just-in-time `uv` installation when needed,
a shared toolchain, and a project-local `.venv`.

For existing Node projects, Fabrica expects a reproducible lockfile
(`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, or `bun.lock`) before
real developer/tester dispatch. Greenfield scaffold mode can materialize the
first deterministic lockfile, but regular runtime pickup fails closed without
one.

`dryRun: true` skips environment provisioning entirely and remains side-effect
free.

**7. Restart the gateway if needed**:

```bash
systemctl --user restart openclaw-gateway.service
```

**8. Trigger a new project programmatically**:

```bash
cd ~/fabrica  # GitHub clone install only
npx tsx scripts/genesis-trigger.ts "A CLI tool that counts words in a file" \
  --stack python-cli \
  --name my-word-counter \
  --dry-run
```

Remove `--dry-run` to execute for real.

**9. Watch the pipeline run**:

```bash
tail -f ~/.openclaw/workspace/logs/genesis.log
```

**10. Check metrics**:

```bash
openclaw fabrica metrics
```

This command now includes convergence-oriented telemetry such as:
- cause counts (for example `qa_missing_required_gates`, `qa_sanitization_failed`)
- human escalations
- average dispatch → first PR timing
- per-stack breakdowns

**11. Inspect a live issue/run**:

```bash
openclaw fabrica doctor issue --project <slug> --issue <id>
```

Use this when a project is looping or stuck. It shows:
- current PR / artifact state
- progress state
- convergence cause + QA subcause
- missing QA gates, when applicable
- recommended next action

For deferred, non-blocking ideas after this milestone, see `FUTURE_IMPROVEMENTS.md`.

## Configuration

### Minimal (gh CLI only)

This mode uses authenticated `gh` CLI for all GitHub operations. Worker models, levels, and workflow routing live in the project workflow files, not in `openclaw.json`.

```json
{
  "plugins": {
    "entries": {
      "fabrica": {
        "config": {
          "work_heartbeat": {
            "enabled": true,
            "intervalSeconds": 60,
            "maxPickupsPerTick": 4
          },
          "projectExecution": "parallel",
          "notifications": {
            "workerStart": true,
            "workerComplete": true
          }
        }
      }
    }
  }
}
```

Optional GitHub App/webhook settings also live under `plugins.entries.fabrica.config.providers.github`.

### With GitHub App / webhook config

Use plugin config when you want explicit webhook behavior or provider auth profiles:

```json
{
  "plugins": {
    "entries": {
      "fabrica": {
        "config": {
          "providers": {
            "github": {
              "defaultAuthProfile": "app",
              "webhookMode": "optional",
              "webhookPath": "/plugins/fabrica/github/webhook",
              "webhookSecretEnv": "FABRICA_GITHUB_WEBHOOK_SECRET",
              "authProfiles": {
                "app": {
                  "mode": "github-app",
                  "appIdEnv": "FABRICA_GITHUB_APP_ID",
                  "privateKeyPathEnv": "FABRICA_GITHUB_APP_KEY_PATH"
                }
              }
            }
          }
        }
      }
    }
  }
}
```

### With Telegram

Telegram is the primary human-facing entrypoint for Fabrica:
- DM with the bot for new-project intake and short clarifications
- one Telegram forum group where Fabrica creates one topic per project

Recommended minimum Telegram configuration:

```json
{
  "channels": {
    "telegram": {
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["<YOUR_TELEGRAM_USER_ID>"],
      "groups": {
        "<YOUR_PROJECTS_FORUM_CHAT_ID>": { "requireMention": false }
      }
    }
  },
  "plugins": {
    "entries": {
      "fabrica": {
        "config": {
          "telegram": {
            "bootstrapDmEnabled": true,
            "projectsForumChatId": "<YOUR_PROJECTS_FORUM_CHAT_ID>",
            "projectsForumAccountId": "<OPTIONAL_TELEGRAM_ACCOUNT_ID>"
          }
        }
      }
    }
  }
}
```

`projectsForumChatId` is the key Fabrica-specific Telegram setting for the official DM → topic flow.

When both `bootstrapDmEnabled=true` and `projectsForumChatId` are present,
`openclaw fabrica setup` automatically prepares the internal `genesis` agent used
for the DM intake path.

`opsChatId` still exists in plugin config for deployments that want a separate ops-only route, but it is not required for the core product flow.

With Telegram enabled, send a project idea to the bot in a DM. Fabrica will ask clarifying questions, provision the GitHub repo, create a dedicated forum topic for the project, and continue the project lifecycle in that topic.

Project topics are event-driven timelines. Fabrica emits explicit messages for
worker start, worker completion, review queueing, reviewer reject/approve, and
operational recovery events, with cycle-aware dedupe so late deliveries from an
older dispatch do not masquerade as current work.

## Minimal path without Telegram

Telegram is the recommended human-facing flow, but it is not required to use Fabrica.

If you want a minimal path without Telegram:
1. authenticate `gh`
2. install the plugin
3. run `openclaw fabrica doctor workspace --workspace /path/to/workspace`
4. run `openclaw fabrica setup --workspace /path/to/workspace --new-agent fabrica`
5. use the programmatic genesis path below to trigger the pipeline

## Programmatic genesis

In addition to Telegram DM bootstrap, the full pipeline can be triggered from a CLI script — no Telegram or running agent session required:

```bash
cd ~/fabrica

npx tsx scripts/genesis-trigger.ts "A REST API that manages book reviews" \
  --stack node-api \
  --name book-reviews-api \
  [--channel-id <TELEGRAM_FORUM_CHAT_ID>] \
  [--dry-run]
```

The script runs the complete pipeline:

1. **Discover phase** — receive → classify → interview → conduct-interview → generate-spec
2. **Commit phase** — provision-repo → scaffold → register → create-task → triage

Pre-set interview answers can be customized by passing `--answers <path-to-json-file>` to the script. The Telegram DM flow is unaffected; both paths share the same underlying pipeline steps.

| Feature | Telegram DM | genesis-trigger.ts |
|---|---|---|
| Forum topic creation | Auto during bootstrap | Auto post-pipeline |
| Interview | Conversational via Telegram | Pre-set answers in script |
| Notifications during intake | To DM | None (silent) |

## Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
npm run test:all
npm run test:hot-path
```

Build:

```bash
npm run build
```

Validate in OpenClaw:

```bash
openclaw plugins list
openclaw fabrica doctor security --json  # security audit
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for a detailed breakdown of the plugin internals, FSM design, and module structure.

## License

[MIT](./LICENSE)
