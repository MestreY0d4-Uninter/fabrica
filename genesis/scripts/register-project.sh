#!/usr/bin/env bash
set -euo pipefail

# Step: Register scaffolded project in DevClaw
# Input: stdin JSON (from scaffold.stdout)
# Output: JSON with registration data + sideband file
# Creates: projects.json entry, workflow.yaml, role prompts, repository labels

GENESIS_LOG="${GENESIS_LOG:-$HOME/.openclaw/workspace/logs/genesis.log}"
mkdir -p "$(dirname "$GENESIS_LOG")"
exec 2> >(tee -a "$GENESIS_LOG" >&2)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$HOME/.openclaw/workspace"
source "$SCRIPT_DIR/sideband-lib.sh"
source "$SCRIPT_DIR/genesis-telemetry.sh"

# Load .env if available
genesis_load_env_file "$HOME/.openclaw/.env"

if [[ -n "${1:-}" && -f "${1:-}" ]]; then
  INPUT="$(cat "$1")"
else
  INPUT="$(cat)"
fi
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id')"
genesis_metric_start "register-project" "$SESSION_ID"
echo "=== $(date -Iseconds) | register-project.sh | session=$SESSION_ID ===" >&2

SCAFFOLD_CREATED="$(echo "$INPUT" | jq -r '.scaffold.created // false')"
DRY_RUN="${GENESIS_DRY_RUN:-$(echo "$INPUT" | jq -r '.dry_run // false')}"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry-run enabled — skipping project registration" >&2
  echo "$INPUT" | jq '. + {project_registered: false, project_registration_pending: "dry_run"}'
  exit 0
fi

# Non-scaffold: passthrough
if [[ "$SCAFFOLD_CREATED" != "true" ]]; then
  echo "No scaffold — skipping registration" >&2
  echo "$INPUT" | jq '. + {project_registered: false}'
  exit 0
fi

SLUG="$(echo "$INPUT" | jq -r '.scaffold.project_slug')"
REPO_URL="$(echo "$INPUT" | jq -r '.scaffold.repo_url')"
REPO_LOCAL="$(echo "$INPUT" | jq -r '.scaffold.repo_local')"
STACK="$(echo "$INPUT" | jq -r '.scaffold.stack')"
REQUESTED_CHANNEL_ID="$(echo "$INPUT" | jq -r '.project_channel_id // .channel_id // .telegram_chat_id // .chat_id // empty')"
# Prefer Fabrica Projects group channel for new projects
# Falls back to TELEGRAM_CHAT_ID only if FABRICA_PROJECTS_CHANNEL_ID is not set
TELEGRAM_CHAT="${FABRICA_PROJECTS_CHANNEL_ID:-${TELEGRAM_CHAT_ID:-}}"
if [[ -n "$REQUESTED_CHANNEL_ID" ]]; then
  TELEGRAM_CHAT="$REQUESTED_CHANNEL_ID"
fi
ALLOW_SHARED_CHANNELS="${GENESIS_ALLOW_SHARED_CHANNELS:-true}"
ALLOW_SHARED_CHANNELS="${ALLOW_SHARED_CHANNELS,,}"
OWNER_REPO="$(genesis_parse_owner_repo "$REPO_URL" || true)"
if [[ -z "$OWNER_REPO" ]]; then
  echo "ERROR: Invalid GitHub repository reference: $REPO_URL" >&2
  exit 1
fi
REPO_REMOTE="https://github.com/$OWNER_REPO.git"

echo "Registering project: $SLUG (stack=$STACK)" >&2

PROJECTS_JSON="$WORKSPACE/devclaw/projects.json"
USE_DEVCLAW_PROJECT_REGISTER_CLI=false
USE_DEVCLAW_PROJECT_LABELS_CLI=false
if genesis_openclaw_supports devclaw project register; then
  USE_DEVCLAW_PROJECT_REGISTER_CLI=true
fi
if genesis_openclaw_supports devclaw project ensure-labels; then
  USE_DEVCLAW_PROJECT_LABELS_CLI=true
fi

# Shared-channel policy guard: avoid silent collisions
if [[ -n "$TELEGRAM_CHAT" ]] && [[ -f "$PROJECTS_JSON" ]]; then
  CHANNEL_MATCHES="$(jq -r --arg slug "$SLUG" --arg chatid "$TELEGRAM_CHAT" '
    .projects
    | to_entries[]
    | select(.key != $slug)
    | select((.value.channels // []) | any(.channelId == $chatid))
    | .key
  ' "$PROJECTS_JSON" 2>/dev/null || true)"

  if [[ -n "$CHANNEL_MATCHES" ]]; then
    CHANNEL_MATCHES_CSV="$(echo "$CHANNEL_MATCHES" | paste -sd "," -)"
    if [[ "$ALLOW_SHARED_CHANNELS" != "true" ]]; then
      echo "WARNING: channelId $TELEGRAM_CHAT already linked to projects: $CHANNEL_MATCHES_CSV" >&2
      echo "GENESIS_ALLOW_SHARED_CHANNELS=$ALLOW_SHARED_CHANNELS -> not attaching channel to new project $SLUG" >&2
      TELEGRAM_CHAT=""
    else
      echo "WARNING: channelId $TELEGRAM_CHAT already linked to projects: $CHANNEL_MATCHES_CSV" >&2
      echo "Proceeding with shared channel (GENESIS_ALLOW_SHARED_CHANNELS=true). Use projectSlug in tools when channel is ambiguous." >&2
    fi
  fi
fi

# --- Check if already registered ---
PROJECT_ALREADY_REGISTERED=false
PROJECT_REGISTERED=false
PROJECT_REGISTRATION_PENDING=""

if jq -e --arg slug "$SLUG" '.projects[$slug]' "$PROJECTS_JSON" &>/dev/null; then
  echo "Project $SLUG already registered in projects.json — skipping" >&2
  PROJECT_ALREADY_REGISTERED=true
  PROJECT_REGISTERED=true
  if [[ -n "$TELEGRAM_CHAT" ]]; then
    PROJECT_HAS_CHANNEL="$(jq -r --arg slug "$SLUG" --arg chatid "$TELEGRAM_CHAT" '
      ((.projects[$slug].channels // []) | any((.channelId // "") == $chatid))
    ' "$PROJECTS_JSON" 2>/dev/null || echo "false")"
    if [[ "$PROJECT_HAS_CHANNEL" != "true" ]]; then
      CHANNEL_LINKED=false
      if genesis_openclaw_supports devclaw channel register; then
        echo "Linking channelId $TELEGRAM_CHAT to existing project $SLUG..." >&2
        if genesis_openclaw_exec devclaw channel register \
          --project "$SLUG" \
          --channel-id "$TELEGRAM_CHAT" \
          --type "telegram" >/dev/null 2>>"$GENESIS_LOG"; then
          echo "Linked channelId $TELEGRAM_CHAT to project $SLUG" >&2
          CHANNEL_LINKED=true
        else
          echo "WARNING: failed to link channelId $TELEGRAM_CHAT to existing project $SLUG" >&2
        fi
      fi
      if [[ "$CHANNEL_LINKED" != "true" ]]; then
        echo "Applying local channel-link fallback for $SLUG -> $TELEGRAM_CHAT" >&2
        if jq --arg slug "$SLUG" --arg chatid "$TELEGRAM_CHAT" '
          .projects[$slug].dispatchEnabled = true
          | .projects[$slug].defaultNotifyChannel = (.projects[$slug].defaultNotifyChannel // "primary")
          | .projects[$slug].projectKind = (.projects[$slug].projectKind // "implementation")
          | .projects[$slug].archived = (.projects[$slug].archived // false)
          | .projects[$slug].channels = (
              ((.projects[$slug].channels // []) + [{
                channel: "telegram",
                name: "primary",
                events: ["*"],
                channelId: $chatid
              }]) | unique_by(.channel + ":" + (.channelId // ""))
            )
        ' "$PROJECTS_JSON" > "${PROJECTS_JSON}.tmp" \
          && mv "${PROJECTS_JSON}.tmp" "$PROJECTS_JSON"; then
          echo "Linked channelId $TELEGRAM_CHAT to project $SLUG via local fallback" >&2
        else
          echo "WARNING: local fallback failed to link channelId $TELEGRAM_CHAT to existing project $SLUG" >&2
        fi
      fi
    fi
  fi
else
  if [[ -z "$TELEGRAM_CHAT" ]]; then
    echo "No TELEGRAM_CHAT_ID available — skipping registration until a channel is linked." >&2
    PROJECT_REGISTRATION_PENDING="missing_channel"
  elif [[ "$USE_DEVCLAW_PROJECT_REGISTER_CLI" == "true" ]]; then
    echo "Registering project via deterministic DevClaw project_register..." >&2
    genesis_openclaw_exec devclaw project register \
      --name "$SLUG" \
      --repo "$REPO_LOCAL" \
      --base-branch "main" \
      --deploy-branch "main" \
      --group-name "Project: $SLUG" \
      --channel-id "$TELEGRAM_CHAT" \
      --channel-type "telegram" \
      --set-default-notify \
      --json >/dev/null 2>>"$GENESIS_LOG"
    PROJECT_REGISTERED=true
  else
    echo "DevClaw project CLI unavailable/incompatible — using local fallback registration." >&2
    echo "Adding $SLUG to projects.json..." >&2

    # Build the new project entry
    NEW_ENTRY="$(jq -n \
      --arg slug "$SLUG" \
      --arg repo "$REPO_LOCAL" \
      --arg remote "$REPO_REMOTE" \
      --arg chatid "$TELEGRAM_CHAT" \
      '{
        slug: $slug,
        name: $slug,
        repo: $repo,
        repoRemote: $remote,
        groupName: ("Project: " + $slug),
        deployUrl: "",
        baseBranch: "main",
        deployBranch: "main",
        defaultNotifyChannel: (if $chatid != "" then "primary" else "" end),
        projectKind: "implementation",
        archived: false,
        dispatchEnabled: (if $chatid != "" then true else false end),
        channels: (if $chatid != "" then [{
          channel: "telegram",
          name: "primary",
          events: ["*"],
          channelId: $chatid
        }] else [] end),
        provider: "github",
        workers: {
          developer: {
            levels: {
              junior: [
                {active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null},
                {active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null}
              ],
              medior: [
                {active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null},
                {active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null}
              ],
              senior: [
                {active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null},
                {active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null}
              ]
            }
          },
          reviewer: {
            levels: {
              junior: [
                {active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null},
                {active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null}
              ],
              senior: [
                {active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null},
                {active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null}
              ]
            }
          },
          tester: {
            levels: {
              junior: [
                {active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null},
                {active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null}
              ],
              medior: [
                {active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null},
                {active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null}
              ],
              senior: [
                {active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null},
                {active: false, issueId: null, sessionKey: null, startTime: null, previousLabel: null}
              ]
            }
          }
        }
      }'
    )"

    # Merge into projects.json (locked write)
    if command -v flock >/dev/null 2>&1; then
      LOCK_FILE="${PROJECTS_JSON}.lock"
      exec 9>"$LOCK_FILE"
      flock -x 9
      jq --arg slug "$SLUG" --argjson entry "$NEW_ENTRY" \
        '.projects[$slug] = $entry' "$PROJECTS_JSON" > "${PROJECTS_JSON}.tmp" \
        && mv "${PROJECTS_JSON}.tmp" "$PROJECTS_JSON"
      flock -u 9
      exec 9>&-
    else
      echo "WARNING: flock not available; proceeding without explicit file lock" >&2
      jq --arg slug "$SLUG" --argjson entry "$NEW_ENTRY" \
        '.projects[$slug] = $entry' "$PROJECTS_JSON" > "${PROJECTS_JSON}.tmp" \
        && mv "${PROJECTS_JSON}.tmp" "$PROJECTS_JSON"
    fi

    echo "Added $SLUG to projects.json" >&2
    PROJECT_REGISTERED=true
  fi
fi

if [[ "$PROJECT_REGISTERED" != "true" ]]; then
  REGISTER_PAYLOAD="$(jq -n \
    --arg slug "$SLUG" \
    --arg reason "$PROJECT_REGISTRATION_PENDING" \
    '{project_slug: $slug, project_registered: false, project_registration_pending: $reason}')"
  SIDEBAND="$(genesis_sideband_write "register" "$SESSION_ID" "$REGISTER_PAYLOAD")"
  echo "Sideband written to $SIDEBAND" >&2
  echo "Registration pending for $SLUG ($PROJECT_REGISTRATION_PENDING)" >&2
  echo "$INPUT" | jq \
    --arg slug "$SLUG" \
    --arg reason "$PROJECT_REGISTRATION_PENDING" \
    '. + {project_registered: false, project_slug: $slug, project_registration_pending: $reason}'
  exit 0
fi

# --- Create workflow.yaml ---
WORKFLOW_DIR="$WORKSPACE/devclaw/projects/$SLUG"
mkdir -p "$WORKFLOW_DIR"

if [[ -f "$WORKFLOW_DIR/workflow.yaml" ]]; then
  echo "workflow.yaml already exists — skipping" >&2
else
  echo "Creating workflow.yaml..." >&2
  cat > "$WORKFLOW_DIR/workflow.yaml" <<'YAMLEOF'
# Project workflow — inherits model allocation from workspace workflow.yaml
# Add role/model overrides here only when this project needs different models.

timeouts:
  dispatchMs: 1800000
  staleWorkerHours: 2

workflow:
  reviewPolicy: agent
  testPolicy: agent
  maxWorkersPerLevel: 1
YAMLEOF
  echo "Created workflow.yaml" >&2
fi

# --- Copy role prompts ---
ROLES_SRC="$WORKSPACE/projects/roles/devclaw-automation"
ROLES_DEFAULT="$WORKSPACE/projects/roles/default"
ROLES_WORKSPACE_DEFAULT="$WORKSPACE/devclaw/prompts"
ROLES_DST="$WORKSPACE/devclaw/projects/$SLUG/prompts"
mkdir -p "$ROLES_DST"

for ROLE in developer reviewer tester; do
  if [[ -f "$ROLES_DST/$ROLE.md" ]]; then
    echo "Role prompt $ROLE.md already exists — skipping" >&2
    continue
  fi

  # Try project-specific source first, then default
  SRC=""
  if [[ -f "$ROLES_SRC/$ROLE.md" ]]; then
    SRC="$ROLES_SRC/$ROLE.md"
  elif [[ -f "$ROLES_DEFAULT/$ROLE.md" ]]; then
    SRC="$ROLES_DEFAULT/$ROLE.md"
  elif [[ -f "$ROLES_WORKSPACE_DEFAULT/$ROLE.md" ]]; then
    SRC="$ROLES_WORKSPACE_DEFAULT/$ROLE.md"
  fi

  if [[ -n "$SRC" ]]; then
    # Copy and replace project name references
    sed "s/devclaw-automation/$SLUG/g" "$SRC" > "$ROLES_DST/$ROLE.md"
    echo "Copied $ROLE.md (from $(basename "$(dirname "$SRC")"))" >&2
  else
    echo "WARNING: No source for $ROLE.md — skipping" >&2
  fi
done

# --- Ensure labels in GitHub repo ---
LABELS_JSON="$SCRIPT_DIR/../configs/labels.json"

if [[ -f "$LABELS_JSON" ]]; then
  # Wait for newly-created repo to propagate across GitHub API nodes
  if [[ "$SCAFFOLD_CREATED" == "true" && "$PROJECT_ALREADY_REGISTERED" != "true" ]]; then
    echo "Waiting for repo propagation (3s)..." >&2
    sleep 3
  fi

  echo "Ensuring labels in $OWNER_REPO..." >&2
  if [[ "$USE_DEVCLAW_PROJECT_LABELS_CLI" == "true" ]]; then
    ENSURE_LABELS_CMD=(devclaw project ensure-labels --project "$SLUG" --labels-file "$LABELS_JSON")
    if [[ -n "$TELEGRAM_CHAT" ]]; then
      ENSURE_LABELS_CMD+=(--notify-channel-id "$TELEGRAM_CHAT")
    fi
    genesis_openclaw_exec "${ENSURE_LABELS_CMD[@]}" --json >/dev/null 2>>"$GENESIS_LOG"
  else
    echo "DevClaw ensure-labels CLI unavailable/incompatible — falling back to gh for custom repo labels." >&2
    LABEL_COUNT=0
    LABEL_TOTAL="$(jq 'length' "$LABELS_JSON")"
    while IFS= read -r label_line; do
      LABEL_NAME="$(echo "$label_line" | jq -r '.name')"
      LABEL_COLOR="$(echo "$label_line" | jq -r '.color')"
      LABEL_DESC="$(echo "$label_line" | jq -r '.description')"

      if gh label create "$LABEL_NAME" \
        --repo "$OWNER_REPO" \
        --color "$LABEL_COLOR" \
        --description "$LABEL_DESC" \
        --force >>"$GENESIS_LOG" 2>&1; then
        LABEL_COUNT=$((LABEL_COUNT + 1))
      else
        echo "  WARN: failed to create label '$LABEL_NAME'" >&2
      fi
      sleep 0.1
    done < <(jq -c '.[]' "$LABELS_JSON")
    echo "Created/updated $LABEL_COUNT / $LABEL_TOTAL labels" >&2

    if [[ -n "$TELEGRAM_CHAT" ]]; then
      gh label create "notify:$TELEGRAM_CHAT" \
        --repo "$OWNER_REPO" \
        --color "e4e4e4" \
        --description "" \
        --force >>"$GENESIS_LOG" 2>&1 || true
    fi
  fi
else
  echo "WARNING: labels.json not found — skipping label creation" >&2
fi

# --- Set up CI foundation (Contract Pack + dependabot) ---
if [[ -n "$REPO_LOCAL" && -d "$REPO_LOCAL" ]]; then
  echo "Setting up CI foundation..." >&2
  GITHUB_DIR="$REPO_LOCAL/.github"
  WORKFLOWS_DIR="$GITHUB_DIR/workflows"
  mkdir -p "$WORKFLOWS_DIR"

  # Determine contract pack based on stack
  PACK_WORKFLOW=""
  case "${STACK,,}" in
    python|fastapi|flask|django|python-cli)
      PACK_WORKFLOW="contract-pack-python.yml"
      DEPENDABOT_ECOSYSTEM="pip"
      ;;
    node|nodejs|express|react|next|vue|typescript)
      PACK_WORKFLOW="contract-pack-node.yml"
      DEPENDABOT_ECOSYSTEM="npm"
      ;;
    *)
      DEPENDABOT_ECOSYSTEM=""
      ;;
  esac

  # Create CI workflow that calls shared workflows
  cat > "$WORKFLOWS_DIR/ci.yml" <<CIEOF
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    uses: MestreY0d4-Uninter/fabrica-automation/.github/workflows/ci-base.yml@main
  security:
    uses: MestreY0d4-Uninter/fabrica-automation/.github/workflows/security.yml@main
CIEOF

  # Add contract pack if stack is known
  if [[ -n "$PACK_WORKFLOW" ]]; then
    cat >> "$WORKFLOWS_DIR/ci.yml" <<PACKEOF
  quality:
    uses: MestreY0d4-Uninter/fabrica-automation/.github/workflows/${PACK_WORKFLOW}@main
PACKEOF
    echo "  Contract Pack: $PACK_WORKFLOW" >&2
  fi

  # Create dependabot config
  cat > "$GITHUB_DIR/dependabot.yml" <<DEPEOF
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
DEPEOF

  if [[ -n "$DEPENDABOT_ECOSYSTEM" ]]; then
    cat >> "$GITHUB_DIR/dependabot.yml" <<DEPEOF
  - package-ecosystem: "${DEPENDABOT_ECOSYSTEM}"
    directory: "/"
    schedule:
      interval: "weekly"
DEPEOF
  fi

  # Commit CI foundation if repo has git
  if [[ -d "$REPO_LOCAL/.git" ]]; then
    (cd "$REPO_LOCAL" && git add .github/ && git commit -m "ci: add shared CI foundation (fabrica-automation)" --no-verify >>"$GENESIS_LOG" 2>&1 && git push origin main >>"$GENESIS_LOG" 2>&1) || true
  fi
  echo "CI foundation set up" >&2
else
  echo "WARNING: REPO_LOCAL not available — skipping CI setup" >&2
fi

# --- Create Telegram Forum Topic ---
if [[ -n "$TELEGRAM_CHAT" && "$PROJECT_REGISTERED" == "true" && "$PROJECT_ALREADY_REGISTERED" != "true" ]]; then
  TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
  if [[ -n "$TELEGRAM_BOT_TOKEN" ]]; then
    echo "Creating forum topic for $SLUG in chat $TELEGRAM_CHAT..." >&2
    TOPIC_RESPONSE="$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createForumTopic" \
      -H "Content-Type: application/json" \
      -d "{\"chat_id\": ${TELEGRAM_CHAT}, \"name\": \"${SLUG}\"}" 2>/dev/null || true)"
    TOPIC_OK="$(echo "$TOPIC_RESPONSE" | jq -r '.ok // false' 2>/dev/null || echo "false")"
    if [[ "$TOPIC_OK" == "true" ]]; then
      TOPIC_ID="$(echo "$TOPIC_RESPONSE" | jq -r '.result.message_thread_id')"
      echo "Forum topic created: $SLUG (messageThreadId=$TOPIC_ID)" >&2
      if jq --arg slug "$SLUG" --argjson tid "$TOPIC_ID" --arg chatid "$TELEGRAM_CHAT" '
        .projects[$slug].channels = [
          .projects[$slug].channels[] |
          if .channel == "telegram" and .channelId == $chatid
          then . + {messageThreadId: $tid}
          else .
          end
        ]
      ' "$PROJECTS_JSON" > "${PROJECTS_JSON}.tmp" \
        && mv "${PROJECTS_JSON}.tmp" "$PROJECTS_JSON"; then
        echo "Updated projects.json with messageThreadId=$TOPIC_ID" >&2
      else
        echo "WARNING: failed to update projects.json with messageThreadId" >&2
      fi
    else
      TOPIC_ERR="$(echo "$TOPIC_RESPONSE" | jq -r '.description // "unknown error"' 2>/dev/null || echo "unknown")"
      echo "WARNING: forum topic creation failed: $TOPIC_ERR (non-blocking)" >&2
    fi
  else
    echo "TELEGRAM_BOT_TOKEN not set — skipping forum topic creation" >&2
  fi
fi

# --- Write sideband file ---
REGISTER_PAYLOAD="$(jq -n \
  --arg slug "$SLUG" \
  --argjson registered true \
  '{project_slug: $slug, project_registered: $registered}')"
SIDEBAND="$(genesis_sideband_write "register" "$SESSION_ID" "$REGISTER_PAYLOAD")"

echo "Sideband written to $SIDEBAND" >&2
echo "Registration complete for $SLUG" >&2

# --- Output ---
echo "$INPUT" | jq \
  --arg slug "$SLUG" \
  '. + {project_registered: true, project_slug: $slug}'

genesis_metric_end "ok"
