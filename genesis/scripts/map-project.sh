#!/usr/bin/env bash
set -euo pipefail

# Step 5: Map project structure using project_mapper
# Input: $1 = repo path (or stdin JSON with metadata.repo_url)
# Output: JSON with project_map to stdout

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${OPENCLAW_PYTHON:-$HOME/.openclaw/.venv/bin/python3}"
MAPPER_V3="$HOME/.openclaw/workspace/scripts/project_mapper_v3.py"
MAPPER_V1="$HOME/.openclaw/workspace/scripts/project_mapper.py"
source "$SCRIPT_DIR/sideband-lib.sh"

PROJECT_REF_INPUT="${1:-}"
REPO_PATH="${PROJECT_REF_INPUT}"
SESSION_ID=""
STATE_INPUT=""
STATE_HAS_INPUT=false

# Always try to load stdin state if present, even when $1 is set.
# This keeps session_id/spec/metadata flowing through the pipeline.
if [[ ! -t 0 ]]; then
  STATE_if [[ -n "${1:-}" && -f "${1:-}" ]]; then
  INPUT="$(cat "$1")"
else
  INPUT="$(cat)"
fi
  if [[ -n "$STATE_INPUT" ]]; then
    STATE_HAS_INPUT=true
    SESSION_ID="$(echo "$STATE_INPUT" | jq -r '.session_id // ""')"
    TARGET_RESOLUTION="$(genesis_resolve_canonical_target "$STATE_INPUT" || jq -n '{metadata:{}}')"
    STATE_INPUT="$(printf '%s' "$STATE_INPUT" | jq --argjson resolved "$TARGET_RESOLUTION" '
      .metadata = ((.metadata // {}) + ($resolved.metadata // {}))
    ')"
  fi
fi

# If no $1, try reading from stdin JSON
if [[ -z "$REPO_PATH" ]] && $STATE_HAS_INPUT; then
  REPO_PATH="$(echo "$STATE_INPUT" | jq -r '.metadata.repo_url // .metadata.repo_path // .repo_url // .repo // ""')"
fi
if [[ -n "$REPO_PATH" && "$REPO_PATH" == "~"* ]]; then
  REPO_PATH="$(genesis_expand_path "$REPO_PATH")"
fi

REPO_URL=""
if [[ "$REPO_PATH" == http* ]]; then
  REPO_URL="$REPO_PATH"
fi

PROJECT_SLUG=""
PROJECT_NAME=""

if $STATE_HAS_INPUT; then
  if [[ -z "$PROJECT_SLUG" ]]; then
    PROJECT_SLUG="$(echo "$STATE_INPUT" | jq -r '.metadata.project_slug // empty')"
  fi
  if [[ -z "$PROJECT_NAME" ]]; then
    PROJECT_NAME="$(echo "$STATE_INPUT" | jq -r '.metadata.project_name // empty')"
  fi
fi

if [[ -n "$REPO_PATH" && "$REPO_PATH" != http* ]] && [[ ! -d "$REPO_PATH" ]]; then
  if PROJECT_REF="$(genesis_project_resolve_ref "$REPO_PATH" || true)"; then
    PROJECT_SLUG="$(printf '%s' "$PROJECT_REF" | cut -f1)"
    PROJECT_NAME="$(printf '%s' "$PROJECT_REF" | cut -f2)"
    RESOLVED_REMOTE="$(printf '%s' "$PROJECT_REF" | cut -f3)"
    RESOLVED_LOCAL="$(printf '%s' "$PROJECT_REF" | cut -f4)"
    if [[ -n "$RESOLVED_REMOTE" ]]; then
      REPO_URL="$RESOLVED_REMOTE"
    fi
    if [[ -n "$RESOLVED_LOCAL" ]]; then
      REPO_PATH="$(genesis_expand_path "$RESOLVED_LOCAL")"
    fi
    echo "Resolved project reference '$PROJECT_REF_INPUT' -> slug=$PROJECT_SLUG repo=$REPO_PATH" >&2
  fi
fi

FACTORY_INTENT_TEXT=""
FACTORY_CHANGE_EXPLICIT=false
if $STATE_HAS_INPUT; then
  FACTORY_INTENT_TEXT="$(echo "$STATE_INPUT" | jq -r '[
    .raw_idea // "",
    .spec.title // "",
    .spec.objective // "",
    .classification.type // ""
  ] | join("\n")')"
  if genesis_payload_factory_change "$STATE_INPUT"; then
    FACTORY_CHANGE_EXPLICIT=true
  fi
fi

if [[ -n "$PROJECT_SLUG" ]] && genesis_is_factory_project_slug "$PROJECT_SLUG"; then
  if [[ "$FACTORY_CHANGE_EXPLICIT" != "true" ]]; then
    echo "ERROR: Target project \"$PROJECT_SLUG\" is reserved for Factory-internal changes. User/product requests must target a dedicated project repository." >&2
    exit 1
  fi
fi

if [[ -n "$PROJECT_SLUG" ]] && [[ -n "$REPO_PATH" ]] && [[ ! -d "$REPO_PATH" ]] && [[ "$REPO_PATH" != http* ]]; then
  echo "ERROR: Registered project \"$PROJECT_SLUG\" resolved to local path \"$REPO_PATH\", but that directory does not exist. Refusing greenfield fallback." >&2
  exit 1
fi

REMOTE_REPO_EXISTS=false
OWNER_REPO_REMOTE=""

# If repo_path is a URL, try to find local clone
if [[ "$REPO_PATH" == http* ]]; then
  REPO_NAME="$(basename "$REPO_PATH" .git)"
  # Common locations for clones
  for candidate in "./$REPO_NAME" "$HOME/$REPO_NAME" "$HOME/git/$REPO_NAME" "$HOME/projects/$REPO_NAME" "$HOME/code/$REPO_NAME"; do
    if [[ -d "$candidate/.git" ]]; then
      REPO_PATH="$candidate"
      echo "Found local clone at $REPO_PATH" >&2
      break
    fi
  done

  OWNER_REPO_REMOTE="$(genesis_parse_owner_repo "$REPO_PATH" || true)"
  if [[ -n "$OWNER_REPO_REMOTE" ]] && command -v gh >/dev/null 2>&1; then
    if gh repo view "$OWNER_REPO_REMOTE" &>/dev/null; then
      REMOTE_REPO_EXISTS=true
      REPO_URL="https://github.com/$OWNER_REPO_REMOTE"
      [[ -n "$PROJECT_SLUG" ]] || PROJECT_SLUG="${OWNER_REPO_REMOTE##*/}"
      echo "Remote repository exists ($OWNER_REPO_REMOTE) even without local clone" >&2
    fi
  fi
fi

# If session_id is missing, keep output stable.
if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="unknown"
fi

# Greenfield project — no repo to map
if [[ -z "$REPO_PATH" ]] || [[ ! -d "$REPO_PATH" ]]; then
  if [[ "$REMOTE_REPO_EXISTS" == "true" ]]; then
    REMOTE_PROJECT="${PROJECT_SLUG:-$(basename "${OWNER_REPO_REMOTE:-remote-project}")}"
    REMOTE_MAP="$(jq -n \
      --arg project "$REMOTE_PROJECT" \
      --arg repo_url "$REPO_URL" \
      '{
        version: "remote-only",
        project: $project,
        root: null,
        repo_url: $repo_url,
        stats: { files_scanned: 0, symbols_found: 0, languages: [] },
        symbols: [],
        note: "Remote repository detected without local clone; treated as existing project."
      }')"
    if $STATE_HAS_INPUT; then
      echo "$STATE_INPUT" | jq \
        --arg sid "$SESSION_ID" \
        --argjson map "$REMOTE_MAP" \
        --arg repo_url "$REPO_URL" \
        --arg project_slug "$PROJECT_SLUG" \
        --arg project_name "$PROJECT_NAME" \
        '. + {
          session_id: $sid,
          step: "map",
          project_map: $map,
          is_greenfield: false,
          map_path: null,
          metadata: (
            (.metadata // {})
            + (if $repo_url != "" then {repo_url: $repo_url} else {} end)
            + (if $project_slug != "" then {project_slug: $project_slug} else {} end)
            + (if $project_name != "" then {project_name: $project_name} else {} end)
          )
        }'
    else
      jq -n \
        --arg sid "$SESSION_ID" \
        --argjson map "$REMOTE_MAP" \
        --arg repo_url "$REPO_URL" \
        '{
          session_id: $sid,
          step: "map",
          project_map: $map,
          is_greenfield: false,
          map_path: null,
          metadata: { repo_url: $repo_url }
        }'
    fi
    exit 0
  fi

  echo "No repository found — treating as greenfield project" >&2
  if $STATE_HAS_INPUT; then
    echo "$STATE_INPUT" | jq \
      --arg sid "$SESSION_ID" \
      '. + {
        session_id: $sid,
        step: "map",
        project_map: {
          version: "3.0",
          project: "greenfield",
          root: null,
          stats: { files_scanned: 0, symbols_found: 0, languages: [] },
          symbols: []
        },
        is_greenfield: true,
        map_path: null
      }'
  else
    jq -n \
      --arg sid "$SESSION_ID" \
      '{
        session_id: $sid,
        step: "map",
        project_map: {
          version: "3.0",
          project: "greenfield",
          root: null,
          stats: { files_scanned: 0, symbols_found: 0, languages: [] },
          symbols: []
        },
        is_greenfield: true,
        map_path: null
      }'
  fi
  exit 0
fi

echo "Mapping project at $REPO_PATH..." >&2

MAP_OUTPUT=""
MAP_PATH=""

# Try v3 (Tree-sitter) first
if [[ -f "$MAPPER_V3" ]] && "$PYTHON" -c "import tree_sitter" 2>/dev/null; then
  echo "Using project_mapper_v3 (Tree-sitter)..." >&2
  MAP_PATH="$REPO_PATH/PROJECT_MAP.json"
  "$PYTHON" "$MAPPER_V3" "$REPO_PATH" >&2 2>&1 || true
  if [[ -f "$MAP_PATH" ]]; then
    MAP_OUTPUT="$(cat "$MAP_PATH")"
  fi
fi

# Fallback to v1 (AST stdlib)
if [[ -z "$MAP_OUTPUT" ]] && [[ -f "$MAPPER_V1" ]]; then
  echo "Falling back to project_mapper v1 (AST stdlib)..." >&2
  MAP_PATH="$REPO_PATH/PROJECT_MAP.json"
  "$PYTHON" "$MAPPER_V1" "$REPO_PATH" >&2 2>&1 || true
  if [[ -f "$MAP_PATH" ]]; then
    MAP_OUTPUT="$(cat "$MAP_PATH")"
  fi
fi

# If no mapper available, create a basic file listing
if [[ -z "$MAP_OUTPUT" ]]; then
  echo "No mapper available — generating basic file listing..." >&2
  FILE_LIST="$(find "$REPO_PATH" -type f \
    -not -path '*/.git/*' \
    -not -path '*/node_modules/*' \
    -not -path '*/__pycache__/*' \
    -not -path '*/.venv/*' \
    -not -path '*/venv/*' \
    -not -path '*/dist/*' \
    -not -path '*/build/*' \
    2>/dev/null | head -200 | sort)"

  MAP_OUTPUT="$(echo "$FILE_LIST" | jq -R -s 'split("\n") | map(select(length > 0)) | {
    version: "1.0-basic",
    project: "'"$(basename "$REPO_PATH")"'",
    root: "'"$REPO_PATH"'",
    stats: { files_scanned: length, symbols_found: 0, languages: [] },
    symbols: [],
    files: .
  }')"
fi

if $STATE_HAS_INPUT; then
  echo "$STATE_INPUT" | jq \
    --arg sid "$SESSION_ID" \
    --argjson map "$MAP_OUTPUT" \
    --arg mp "${MAP_PATH:-}" \
    --arg repo_path "$REPO_PATH" \
    --arg repo_url "$REPO_URL" \
    --arg project_slug "$PROJECT_SLUG" \
    --arg project_name "$PROJECT_NAME" \
    '. + {
      session_id: $sid,
      step: "map",
      project_map: $map,
      is_greenfield: false,
      map_path: (if $mp != "" then $mp else null end),
      metadata: (
        (.metadata // {})
        + (if $repo_url != "" then {repo_url: $repo_url} else {} end)
        + (if $repo_path != "" and ($repo_path | startswith("http") | not) then {repo_path: $repo_path} else {} end)
        + (if $project_slug != "" then {project_slug: $project_slug} else {} end)
        + (if $project_name != "" then {project_name: $project_name} else {} end)
      )
    }'
else
  jq -n \
    --arg sid "$SESSION_ID" \
    --argjson map "$MAP_OUTPUT" \
    --arg mp "${MAP_PATH:-}" \
    '{
      session_id: $sid,
      step: "map",
      project_map: $map,
      is_greenfield: false,
      map_path: (if $mp != "" then $mp else null end)
    }'
fi
