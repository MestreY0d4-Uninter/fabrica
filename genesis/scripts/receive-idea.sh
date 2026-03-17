#!/usr/bin/env bash
set -euo pipefail

# Step 1: Receive and envelope a raw idea
# Input: $1 = idea text, $2 = session_id (optional)
# Output: JSON envelope to stdout

IDEA="${1:-${GENESIS_IDEA:-}}"
SESSION_ID="${2:-}"
FACTORY_CHANGE_RAW="${GENESIS_FACTORY_CHANGE:-false}"
ANSWERS_JSON_RAW="${GENESIS_ANSWERS_JSON:-}"

if [[ -z "$IDEA" ]]; then
  echo "Usage: receive-idea.sh <idea> [session-id] (or set GENESIS_IDEA)" >&2
  exit 1
fi

if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  echo "Generated session: $SESSION_ID" >&2
fi

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
FACTORY_CHANGE_NORMALIZED="$(printf '%s' "$FACTORY_CHANGE_RAW" | tr '[:upper:]' '[:lower:]')"
FACTORY_CHANGE=false
if [[ "$FACTORY_CHANGE_NORMALIZED" == "true" || "$FACTORY_CHANGE_NORMALIZED" == "1" || "$FACTORY_CHANGE_NORMALIZED" == "yes" || "$FACTORY_CHANGE_NORMALIZED" == "on" ]]; then
  FACTORY_CHANGE=true
fi

DEFAULT_REPO_URL=""
DEFAULT_PROJECT_NAME=""
if [[ "$FACTORY_CHANGE" == "true" ]]; then
  DEFAULT_REPO_URL="${GENESIS_REPO_URL:-}"
  DEFAULT_PROJECT_NAME="${GENESIS_DEFAULT_PROJECT:-}"
fi

ANSWERS_JSON='{}'
if [[ -n "$ANSWERS_JSON_RAW" ]]; then
  if printf '%s' "$ANSWERS_JSON_RAW" | jq -e 'type == "object"' >/dev/null 2>&1; then
    ANSWERS_JSON="$ANSWERS_JSON_RAW"
  else
    echo "WARNING: GENESIS_ANSWERS_JSON is not a valid JSON object; ignoring" >&2
  fi
fi

jq -n \
  --arg sid "$SESSION_ID" \
  --arg ts "$TIMESTAMP" \
  --arg idea "$IDEA" \
  --arg repo "$DEFAULT_REPO_URL" \
  --arg project "$DEFAULT_PROJECT_NAME" \
  --arg factory_change "$FACTORY_CHANGE_RAW" \
  --argjson answers "$ANSWERS_JSON" \
  '{
    session_id: $sid,
    timestamp: $ts,
    step: "receive",
    raw_idea: $idea,
    answers: $answers,
    metadata: {
      source: "genesis-cli",
      repo_url: (if $repo != "" then $repo else null end),
      project_name: (if $project != "" then $project else null end),
      factory_change: (
        ($factory_change | ascii_downcase) as $fc
        | ($fc == "true" or $fc == "1" or $fc == "yes" or $fc == "on")
      )
    }
  }'
