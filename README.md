# Fabrica Plugin

Fabrica is the main OpenClaw plugin in this repository. It owns the engineering
workflow from intake through delivery:

`intake -> issue -> developer -> review -> test -> merge -> done`

This directory is the source of truth for the plugin. The official local
installation points back to this path with:

```bash
openclaw plugins install -l /home/mateus/Fabrica/fabrica
```

The runtime loads the built entrypoint from:

`/home/mateus/Fabrica/fabrica/dist/index.js`

## Local workflow

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

Validate the plugin in OpenClaw:

```bash
openclaw plugins list
openclaw plugins doctor
openclaw fabrica doctor security --json
```

## Telegram operating model

Fabrica now uses a DM-first bootstrap flow for new projects:

1. Send a new-project request to the bot in a Telegram DM.
2. If required fields are missing, Fabrica asks short clarification questions in the DM.
3. For greenfield projects, Fabrica provisions the GitHub repository and local
   clone automatically from the intake plan.
4. Once the intake is ready to register, Fabrica creates a forum topic in the
   configured projects group and registers the project against that exact
   `channelId + messageThreadId` route.
5. Project execution, follow-ups, worker status, review, test, merge, and done
   updates continue in the project topic.

Recommended channel split:

- projects forum group: one Telegram topic per project
- ops group: cron, heartbeat, health, and operational alerts only

The local config is expected to include:

```json
{
  "channels": {
    "telegram": {
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["6951571380"],
      "groups": {
        "-1003709213169": { "requireMention": false }
      }
    }
  },
  "plugins": {
    "entries": {
      "fabrica": {
        "config": {
          "telegram": {
            "bootstrapDmEnabled": true,
            "projectsForumChatId": "-1003709213169",
            "opsChatId": "-1003746141948"
          }
        }
      }
    }
  }
}
```

Validate the GitHub webhook route:

```bash
curl -i -X POST http://127.0.0.1:18789/plugins/fabrica/github/webhook \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Expected response without GitHub headers/signature:

`400 {"ok":false,"reason":"missing_headers"}`

## Programmatic Genesis (CLI gap)

In addition to Telegram DM bootstrap, genesis can be triggered programmatically
via the standalone script `scripts/genesis-trigger.ts`:

```bash
# From ~/Fabrica/fabrica/
npx tsx scripts/genesis-trigger.ts "Ideia do projeto" \
  --stack python-cli \
  --name meu-projeto-cli \
  [--channel-id -1003709213169] \
  [--dry-run]
```

This script:
1. Runs the full discover phase (receive → classify → interview → conduct-interview → generate-spec)
2. Injects pre-set interview answers (edit the `answers` object in the script to customize)
3. Runs the full commit phase (provision-repo → scaffold → register → create-task → triage)
4. Creates a Telegram forum topic and updates `projects.json` with `messageThreadId`

**Compatibility note**: This script does NOT break the Telegram flow. The Telegram
DM bootstrap path continues to work as before. The programmatic path is an
additive gap that calls the same underlying pipeline steps.

**Requirements for register step**: `--channel-id` must point to a valid Telegram
forum group chat ID where the bot can create topics. Defaults to the Fabrica
Projects forum (`-1003709213169`).

### Known differences from Telegram DM flow

| Feature | Telegram DM | genesis-trigger.ts |
|---|---|---|
| Forum topic creation | Auto (during bootstrap) | Auto (post-pipeline) |
| Interview | Conversational via Telegram | Pre-set answers in script |
| LLM classification | Via `openclaw agent --local` | Same (may fallback to keyword) |
| Notifications during intake | To DM | None (silent) |
| `metadata.channel_id` | From Telegram chat | From `--channel-id` flag |

## Notes

- Do not copy this plugin manually into `~/.openclaw/extensions`.
- Keep the installation official through `openclaw plugins install -l`.
- GitHub App credentials stay outside the repository and should be wired from
  the Fabrica plugin config inside `~/.openclaw/openclaw.json`, preferably via
  file paths under `~/.openclaw/credentials/`.
- The supported GitHub config pattern is path/value based, not shell-local env:

```json
{
  "plugins": {
    "entries": {
      "fabrica": {
        "config": {
          "providers": {
            "github": {
              "webhookPath": "/plugins/fabrica/github/webhook",
              "webhookSecretPath": "/home/mateus/.openclaw/credentials/fabrica-github-webhook-secret",
              "defaultAuthProfile": "main",
              "authProfiles": {
                "main": {
                  "mode": "github-app",
                  "appId": "3087504",
                  "privateKeyPath": "/home/mateus/.openclaw/credentials/fabrica-github-app.pem"
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

- Legacy `*Env` fields still work as fallback for compatibility, but they are no
  longer the recommended source of truth.
