# Fabrica

[![npm version](https://img.shields.io/npm/v/@mestreyoda/fabrica)](https://www.npmjs.com/package/@mestreyoda/fabrica)
[![license](https://img.shields.io/npm/l/@mestreyoda/fabrica)](./LICENSE)

> Autonomous software engineering pipeline for OpenClaw.

Fabrica turns a natural-language project description into a fully executed engineering workflow: intake, specification, issue decomposition, development, code review, testing, and merge — with zero manual intervention. It orchestrates AI agents as specialized workers (developers, reviewers, testers) through a deterministic finite state machine.

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

The heartbeat ticks every 60 seconds. On each tick, Fabrica alternates between a **repair** pass (fixes stale states) and a **triage** pass (advances work that is ready to move). No human intervention is required after the initial project description.

## Features

- **Zero-intervention pipeline** — from idea to merged PR without manual steps
- **Deterministic FSM** — every transition is explicit; states are `planning → todo → doing → toReview → toTest → done` (+ `refining`, `toImprove`, `rejected`)
- **Pluggable AI workers** — each role (developer, reviewer, tester, architect) maps to a configurable model and level
- **Polling-first GitHub integration** — no webhook infrastructure required; GitHub App is optional
- **Telegram bootstrap** (optional) — describe a new project via DM; Fabrica asks clarifying questions and provisions the repo automatically
- **Programmatic genesis** — trigger the full pipeline from a CLI script without Telegram
- **Observability built-in** — audit log, metrics subcommand, heartbeat health checks, and OpenTelemetry tracing
- **Safe-by-default** — conflict detection, mutex-guarded heartbeat, session validation, and label integrity guards

## Requirements

- [OpenClaw](https://openclaw.dev) runtime >= 2026.3.13 (gateway running on port 18789)
- Git (for repository operations and local development)
- Node.js 20+ (for local development or programmatic genesis)
- `gh` CLI authenticated to GitHub (required for issue and PR operations)
- A GitHub organization or personal account where repositories will be created
- (Optional) Telegram bot token and group chat IDs for DM bootstrap and notifications

## Installation

### Via npm (recommended)

```bash
openclaw plugins install @mestreyoda/fabrica
```

### Via GitHub clone

```bash
git clone https://github.com/MestreY0d4-Uninter/fabrica-plugin ~/fabrica-plugin
openclaw plugins install -l ~/fabrica-plugin
```

After installation, verify the plugin loaded correctly:

```bash
openclaw plugins list
openclaw fabrica doctor
```

## Quick start

**1. Configure the plugin** in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "fabrica": {
        "config": {
          "github": {
            "org": "<YOUR_GITHUB_ORG_OR_USER>"
          }
        }
      }
    }
  }
}
```

**2. Restart the gateway**:

```bash
systemctl --user restart openclaw-gateway.service
```

**3. Trigger a new project programmatically**:

```bash
cd ~/fabrica-plugin  # GitHub clone install only
npx tsx scripts/genesis-trigger.ts "A CLI tool that counts words in a file" \
  --stack python-cli \
  --name my-word-counter \
  --dry-run
```

Remove `--dry-run` to execute for real.

**4. Watch the pipeline run**:

```bash
tail -f ~/.openclaw/workspace/logs/genesis.log
```

**5. Check metrics**:

```bash
openclaw fabrica metrics
```

## Configuration

### Minimal (gh CLI only)

This configuration uses `gh` CLI for all GitHub operations (no GitHub App needed):

```json
{
  "plugins": {
    "entries": {
      "fabrica": {
        "config": {
          "github": {
            "org": "<YOUR_GITHUB_ORG_OR_USER>"
          },
          "workers": {
            "developer": { "model": "gpt-4o", "level": "medior" },
            "reviewer":  { "model": "gpt-4o", "level": "senior" },
            "tester":    { "model": "gpt-4o", "level": "medior" }
          }
        }
      }
    }
  }
}
```

### With Telegram

Telegram enables DM-based project bootstrap and per-project forum topic notifications.

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
            "opsChatId": "<YOUR_OPS_CHAT_ID>"
          }
        }
      }
    }
  }
}
```

With Telegram enabled, send a project idea to the bot in a DM. Fabrica will ask clarifying questions, provision the GitHub repo, and create a dedicated forum topic for the project. All subsequent worker updates, review results, and the final merge notification appear in that topic.

### With GitHub App (advanced)

A GitHub App enables webhook-driven PR state updates, reducing polling latency. This is optional; polling works out of the box.

```json
{
  "plugins": {
    "entries": {
      "fabrica": {
        "config": {
          "providers": {
            "github": {
              "webhookPath": "/plugins/fabrica/github/webhook",
              "webhookSecretPath": "<PATH_TO_WEBHOOK_SECRET_FILE>",
              "defaultAuthProfile": "main",
              "authProfiles": {
                "main": {
                  "mode": "github-app",
                  "appId": "<YOUR_APP_ID>",
                  "privateKeyPath": "<PATH_TO_APP_PRIVATE_KEY_PEM>"
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

Store credential files outside the repository (e.g., `~/.openclaw/credentials/`). Verify the webhook route is reachable:

```bash
curl -i -X POST http://127.0.0.1:18789/plugins/fabrica/github/webhook \
  -H 'Content-Type: application/json' \
  -d '{}'
# Expected: 400 {"ok":false,"reason":"missing_headers"}
```

## Programmatic genesis

In addition to Telegram DM bootstrap, the full pipeline can be triggered from a CLI script — no Telegram or running agent session required:

```bash
cd ~/fabrica-plugin

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
