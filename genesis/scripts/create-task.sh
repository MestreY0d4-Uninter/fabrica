#!/usr/bin/env bash
set -euo pipefail

# Step 9: Create GitHub issue from session state
# Input: stdin JSON (complete session state)
# Output: JSON with issue data to stdout
# Requires: openclaw CLI + DevClaw plugin (deterministic path),
#           gh CLI authenticated (idempotency checks/fallback),
#           GENESIS_REPO_URL in env or metadata

GENESIS_LOG="${GENESIS_LOG:-$HOME/.openclaw/workspace/logs/genesis.log}"
mkdir -p "$(dirname "$GENESIS_LOG")"
exec 2> >(tee -a "$GENESIS_LOG" >&2)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/sideband-lib.sh"
source "$SCRIPT_DIR/genesis-telemetry.sh"

genesis_normalize_text() {
  tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/ /g; s/^[[:space:]]+//; s/[[:space:]]+$//; s/[[:space:]]+/ /g'
}

genesis_sha1() {
  if command -v sha1sum >/dev/null 2>&1; then
    sha1sum | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 1 | awk '{print $1}'
    return 0
  fi
  return 1
}

genesis_backlog_label_for_type() {
  local type="${1:-feature}"
  case "$type" in
    research)
      printf '%s\n' "backlog:meta"
      ;;
    *)
      printf '%s\n' "backlog:canonical"
      ;;
  esac
}

genesis_backlog_label_from_input() {
  local input_json="${1:-}"
  local spec_type="${2:-feature}"
  local raw=""

  raw="$(printf '%s' "$input_json" | jq -r '
    .metadata.backlog.label
    // .metadata.backlog.kind
    // .backlog.label
    // .backlog.kind
    // empty
  ' 2>/dev/null || true)"
  raw="$(genesis_trim "$raw")"
  if [[ -n "$raw" ]]; then
    case "$raw" in
      canonical|duplicate|tracking|meta)
        printf 'backlog:%s\n' "$raw"
        return 0
        ;;
      backlog:canonical|backlog:duplicate|backlog:tracking|backlog:meta)
        printf '%s\n' "$raw"
        return 0
        ;;
    esac
  fi

  genesis_backlog_label_for_type "$spec_type"
}

genesis_backlog_metadata_json() {
  local input_json="${1:-}"
  local project_slug="${2:-}"
  local spec_type="${3:-feature}"
  local default_series default_order

  default_series="${project_slug:-genesis-default}"
  default_order="10"

  printf '%s' "$input_json" | jq -c \
    --arg default_series "$default_series" \
    --arg default_type "$spec_type" \
    --argjson default_order "$default_order" '
      def parse_refs($value):
        if $value == null then []
        elif ($value | type) == "array" then [$value[] | tonumber? // empty]
        elif ($value | type) == "number" then [$value]
        elif ($value | type) == "string" then (
          $value
          | split(",")
          | map(gsub("^\\s+|\\s+$"; ""))
          | map(select(length > 0))
          | map(tonumber? // empty)
        )
        else []
        end;
      def parse_optional_refs($value):
        (parse_refs($value)) as $refs
        | if ($refs | length) > 0 then $refs else null end;
      . as $root
      | ($root.metadata.backlog // $root.backlog // {}) as $backlog
      | {
          series: (
            $backlog.series
            // $root.metadata.backlog_series
            // $root.metadata.project_slug
            // $root.project_slug
            // $root.metadata.project_name
            // $default_series
          ),
          order: (
            $backlog.order
            // $root.metadata.backlog_order
            // $default_order
          ),
          dependsOn: (
            parse_refs(
              $backlog.dependsOn
              // $backlog.depends_on
              // $root.metadata.backlog_depends_on
            )
          ),
          supersededBy: (
            parse_optional_refs(
              $backlog.supersededBy
              // $backlog.superseded_by
              // $root.metadata.backlog_superseded_by
            )
          )
        }
      | .order |= (tonumber? // $default_order)
    ' 2>/dev/null
}

# Load .env if available
genesis_load_env_file "$HOME/.openclaw/.env"

# Dry-run: output preview without creating issue
if [[ "${GENESIS_DRY_RUN:-false}" == "true" ]]; then
  if [[ -n "${1:-}" && -f "${1:-}" ]]; then
  INPUT="$(cat "$1")"
else
  INPUT="$(cat)"
fi
  echo '{"step":"create_task","dry_run":true,"message":"Dry run — issue creation skipped. Pipeline complete.","session_id":"'"$(echo "$INPUT" | jq -r '.session_id')"'"}' >&1
  exit 0
fi

if [[ -n "${1:-}" && -f "${1:-}" ]]; then
  INPUT="$(cat "$1")"
else
  INPUT="$(cat)"
fi
TARGET_RESOLUTION="$(genesis_resolve_canonical_target "$INPUT" || jq -n '{metadata:{}}')"
INPUT="$(printf '%s' "$INPUT" | jq --argjson resolved "$TARGET_RESOLUTION" '
  .metadata = ((.metadata // {}) + ($resolved.metadata // {}))
')"
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id')"
genesis_metric_start "create-task" "$SESSION_ID"
echo "=== $(date -Iseconds) | create-task.sh | session=$SESSION_ID ===" >&2
SPEC="$(echo "$INPUT" | jq '.spec // {}')"
SECURITY="$(echo "$INPUT" | jq '.security // {}')"
QA_CONTRACT="$(echo "$INPUT" | jq '.qa_contract // {}')"
METADATA="$(echo "$INPUT" | jq '.metadata // {}')"
CLASSIFICATION="$(echo "$INPUT" | jq '.classification // {}')"
INTERVIEW="$(echo "$INPUT" | jq '.interview // {}')"
IMPACT="$(echo "$INPUT" | jq '.impact // {}')"
PROJECT_MAP="$(echo "$INPUT" | jq '.project_map // {}')"
SPEC_TITLE_SIGNAL="$(echo "$SPEC" | jq -r '.title // ""')"
SPEC_OBJECTIVE_SIGNAL="$(echo "$SPEC" | jq -r '.objective // ""')"
SPEC_TYPE="$(echo "$SPEC" | jq -r '.type // "feature"')"
SPEC_DELIVERY_TARGET="$(echo "$SPEC" | jq -r '.delivery_target // "unknown"')"
FACTORY_CHANGE_FROM_SPEC=false
if genesis_payload_factory_change "$INPUT"; then
  FACTORY_CHANGE_FROM_SPEC=true
elif genesis_request_is_factory_change "$(printf '%s\n%s\n' "$SPEC_TITLE_SIGNAL" "$SPEC_OBJECTIVE_SIGNAL")"; then
  FACTORY_CHANGE_FROM_SPEC=true
fi

echo "Creating GitHub issue for session $SESSION_ID..." >&2

# Determine repo (prefer current pipeline state; avoid implicit default target for product flows)
REPO_URL="$(echo "$INPUT" | jq -r '.scaffold.repo_url // .metadata.repo_url // ""')"
CANDIDATE_PROJECT_SLUG="$(echo "$INPUT" | jq -r '.project_slug // .metadata.project_slug // .scaffold.project_slug // empty')"
if [[ -z "$CANDIDATE_PROJECT_SLUG" || "$CANDIDATE_PROJECT_SLUG" == "null" ]]; then
  CANDIDATE_PROJECT_SLUG="$(echo "$INPUT" | jq -r '.metadata.project_name // empty')"
fi
REQUESTED_CHANNEL_ID="$(echo "$INPUT" | jq -r '.project_channel_id // empty')"
PROJECT_SLUG=""

# Sideband: if scaffold created a new repo, use that (validated + TTL-bound)
SCAFFOLD_PAYLOAD="$(genesis_sideband_read_payload "scaffold" "$SESSION_ID" "${GENESIS_SIDEBAND_TTL_SECONDS:-1800}" || true)"
if [[ -z "$REPO_URL" && -n "$SCAFFOLD_PAYLOAD" ]]; then
  SCAFFOLD_REPO="$(echo "$SCAFFOLD_PAYLOAD" | jq -r '.scaffold.repo_url // empty')"
  if [[ -n "$SCAFFOLD_REPO" ]]; then
    REPO_URL="$SCAFFOLD_REPO"
    echo "Using scaffolded repo: $REPO_URL" >&2
  fi
fi

if [[ -z "$REPO_URL" ]]; then
  if [[ -n "$CANDIDATE_PROJECT_SLUG" && "$CANDIDATE_PROJECT_SLUG" != "null" ]]; then
    PROJECT_REF="$(genesis_project_resolve_ref "$CANDIDATE_PROJECT_SLUG" || true)"
    if [[ -n "$PROJECT_REF" ]]; then
      RESOLVED_REMOTE="$(printf '%s' "$PROJECT_REF" | cut -f3)"
      if [[ -n "$RESOLVED_REMOTE" ]]; then
        REPO_URL="$RESOLVED_REMOTE"
        echo "Resolved repo from project slug '$CANDIDATE_PROJECT_SLUG': $REPO_URL" >&2
      fi
    fi
  fi
fi
if [[ -z "$REPO_URL" ]]; then
  if [[ "$FACTORY_CHANGE_FROM_SPEC" == "true" && -n "${GENESIS_REPO_URL:-}" ]]; then
    REPO_URL="${GENESIS_REPO_URL}"
    echo "Using GENESIS_REPO_URL fallback for factory/internal change." >&2
  fi
fi
if [[ -z "$REPO_URL" ]]; then
  echo "ERROR: No repo URL resolved from pipeline state (scaffold/metadata). Refusing implicit fallback for product request." >&2
  exit 1
fi
if [[ -n "$REPO_URL" && "$REPO_URL" == "~"* ]]; then
  REPO_URL="$(genesis_expand_path "$REPO_URL")"
fi

# If repo URL was not explicit owner/repo, resolve project ref deterministically.
if [[ -n "$REPO_URL" ]] && ! genesis_parse_owner_repo "$REPO_URL" >/dev/null 2>&1; then
  PROJECT_REF="$(genesis_project_resolve_ref "$REPO_URL" || true)"
  if [[ -n "$PROJECT_REF" ]]; then
    PROJECT_SLUG="$(printf '%s' "$PROJECT_REF" | cut -f1)"
    RESOLVED_REMOTE="$(printf '%s' "$PROJECT_REF" | cut -f3)"
    if [[ -n "$RESOLVED_REMOTE" ]]; then
      REPO_URL="$RESOLVED_REMOTE"
      echo "Resolved repo reference via project map: $REPO_URL" >&2
    fi
  fi
fi

# Extract owner/repo from URL
OWNER_REPO="$(genesis_parse_owner_repo "$REPO_URL" || true)"
if [[ -z "$OWNER_REPO" ]]; then
  echo "ERROR: Invalid GitHub repository reference: $REPO_URL" >&2
  exit 1
fi
OWNER="$(echo "$OWNER_REPO" | cut -d/ -f1)"
REPO="$(echo "$OWNER_REPO" | cut -d/ -f2)"

# Resolve project slug deterministically from projects.json.
REPO_PROJECT_SLUG="$(genesis_find_project_slug_by_repo "$REPO_URL" || true)"
if [[ -n "$REPO_PROJECT_SLUG" ]]; then
  if [[ -n "$CANDIDATE_PROJECT_SLUG" && "$CANDIDATE_PROJECT_SLUG" != "$REPO_PROJECT_SLUG" ]]; then
    echo "WARNING: Provided project slug '$CANDIDATE_PROJECT_SLUG' does not match repo mapping; using '$REPO_PROJECT_SLUG'." >&2
  fi
  PROJECT_SLUG="$REPO_PROJECT_SLUG"
elif [[ -n "$CANDIDATE_PROJECT_SLUG" ]] && genesis_project_exists "$CANDIDATE_PROJECT_SLUG"; then
  PROJECT_SLUG="$CANDIDATE_PROJECT_SLUG"
elif [[ -n "$CANDIDATE_PROJECT_SLUG" ]]; then
  echo "WARNING: Provided project slug '$CANDIDATE_PROJECT_SLUG' is not registered in projects.json." >&2
fi

PROJECT_KIND="implementation"
PROJECT_ARCHIVED="false"
if [[ -n "$PROJECT_SLUG" ]] && genesis_project_exists "$PROJECT_SLUG"; then
  PROJECT_KIND="$(genesis_project_kind "$PROJECT_SLUG" || echo implementation)"
  PROJECT_ARCHIVED="$(genesis_project_archived "$PROJECT_SLUG" || echo false)"
fi

if [[ "$PROJECT_ARCHIVED" == "true" ]]; then
  echo "ERROR: Target project \"$PROJECT_SLUG\" is archived and cannot receive new issues. Redirect to the canonical active project before retrying." >&2
  exit 1
fi

if [[ "$PROJECT_KIND" == "pointer" ]] && [[ "$SPEC_TYPE" != "research" ]]; then
  echo "ERROR: Target project \"$PROJECT_SLUG\" is marked as pointer/scaffold and cannot receive implementation issues." >&2
  exit 1
fi

if [[ -n "$PROJECT_SLUG" ]] && genesis_is_factory_project_slug "$PROJECT_SLUG"; then
  if ! genesis_payload_factory_change "$INPUT"; then
    echo "ERROR: Target project \"$PROJECT_SLUG\" is reserved for Factory-internal changes. User/product requests must target a dedicated project repository." >&2
    exit 1
  fi
fi

PROJECT_CHANNEL_ID=""
if [[ -n "$PROJECT_SLUG" ]]; then
  PROJECT_CHANNEL_ID="$(genesis_project_channel_id "$PROJECT_SLUG" "$REQUESTED_CHANNEL_ID" || true)"
  if [[ -n "$REQUESTED_CHANNEL_ID" && -n "$PROJECT_CHANNEL_ID" && "$REQUESTED_CHANNEL_ID" != "$PROJECT_CHANNEL_ID" ]]; then
    echo "WARNING: Requested channel '$REQUESTED_CHANNEL_ID' is not valid for '$PROJECT_SLUG'; using '$PROJECT_CHANNEL_ID' from projects.json." >&2
  fi
fi
USE_FABRICA_TASKS=false
if [[ -n "$PROJECT_SLUG" && -n "$PROJECT_CHANNEL_ID" ]] && genesis_openclaw_bin >/dev/null 2>&1 && genesis_openclaw_supports fabrica task; then
  USE_FABRICA_TASKS=true
fi

echo "Target: $OWNER/$REPO" >&2

# Lock by repo+session to avoid duplicate issue creation under concurrent runs.
CREATE_LOCK_DIR="$HOME/.openclaw/workspace/$FABRICA_DATA_DIR/log"
LOCK_SAFE_KEY="$(printf '%s_%s_%s' "$OWNER" "$REPO" "$SESSION_ID" | tr -c 'A-Za-z0-9._-' '_')"
CREATE_LOCK_FILE="$CREATE_LOCK_DIR/create-task-${LOCK_SAFE_KEY}.lock"
mkdir -p "$CREATE_LOCK_DIR"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$CREATE_LOCK_FILE"
  flock -x 9
fi

# === Idempotency check: prevent duplicate issues for the same session ===
echo "Checking for existing issue with session_id $SESSION_ID..." >&2

EXISTING_ISSUE="$(gh issue list \
  --repo "$OWNER/$REPO" \
  --state all \
  --search "Session: $SESSION_ID in:body" \
  --json number,url,title,state \
  --limit 1 2>/dev/null || echo "[]")"

EXISTING_NUMBER="$(echo "$EXISTING_ISSUE" | jq -r '.[0].number // empty' 2>/dev/null || true)"

if [[ -n "$EXISTING_NUMBER" ]]; then
  EXISTING_URL="$(echo "$EXISTING_ISSUE" | jq -r '.[0].url')"
  EXISTING_TITLE="$(echo "$EXISTING_ISSUE" | jq -r '.[0].title')"
  EXISTING_STATE="$(echo "$EXISTING_ISSUE" | jq -r '.[0].state')"

  echo "Found existing issue #$EXISTING_NUMBER ($EXISTING_STATE) for session $SESSION_ID — skipping creation" >&2

  # Reopen if closed
  if [[ "$EXISTING_STATE" == "CLOSED" ]]; then
    echo "Reopening existing issue #$EXISTING_NUMBER..." >&2
    gh issue reopen "$EXISTING_NUMBER" --repo "$OWNER/$REPO" >/dev/null 2>&1 || true
  fi

  jq -n \
    --arg sid "$SESSION_ID" \
    --argjson num "$EXISTING_NUMBER" \
    --arg title "$EXISTING_TITLE" \
    --arg url "$EXISTING_URL" \
    --arg project_slug "$PROJECT_SLUG" \
    --arg project_channel_id "$PROJECT_CHANNEL_ID" \
    --arg labels "Planning" \
    --argjson factory_change "$([[ "$FACTORY_CHANGE_FROM_SPEC" == "true" ]] && echo "true" || echo "false")" \
    --argjson spec "$SPEC" \
    --argjson cls "$CLASSIFICATION" \
    --argjson interview "$INTERVIEW" \
    --argjson impact "$IMPACT" \
    --argjson qa "$QA_CONTRACT" \
    --argjson sec "$SECURITY" \
    --argjson map "$PROJECT_MAP" \
    --argjson meta "$METADATA" \
    '{
      session_id: $sid,
      step: "create_task",
      duplicate_prevented: true,
      factory_change: $factory_change,
      project_slug: (if $project_slug != "" then $project_slug else null end),
      project_channel_id: (if $project_channel_id != "" then $project_channel_id else null end),
      issues: [{
        number: $num,
        title: $title,
        url: $url,
        labels: ($labels | split(",")),
        state: "open"
      }],
      spec: $spec,
      classification: $cls,
      interview: $interview,
      impact: $impact,
      qa_contract: $qa,
      security: $sec,
      project_map: $map,
      metadata: $meta
    }'
  exit 0
fi
# === End idempotency check ===

# Extract spec fields
TITLE="$(echo "$SPEC" | jq -r '.title')"
TYPE="$(echo "$SPEC" | jq -r '.type')"
OBJECTIVE="$(echo "$SPEC" | jq -r '.objective')"
CONSTRAINTS="$(echo "$SPEC" | jq -r '.constraints // "None"')"
DELIVERY_TARGET="$(echo "$SPEC" | jq -r '.delivery_target // "unknown"')"

DEDUPE_SOURCE="$OBJECTIVE"
if [[ -z "${DEDUPE_SOURCE// }" || "$DEDUPE_SOURCE" == "null" ]]; then
  DEDUPE_SOURCE="$TITLE"
fi
DEDUPE_KEY=""
DEDUPE_NORM="$(printf '%s' "$DEDUPE_SOURCE" | genesis_normalize_text | cut -c1-240)"
if [[ -n "$DEDUPE_NORM" ]]; then
  DEDUPE_KEY="$(printf '%s' "$DEDUPE_NORM" | genesis_sha1 || true)"
fi

if [[ -n "$DEDUPE_KEY" ]]; then
  EXISTING_DEDUPE_ISSUE="$(gh issue list \
    --repo "$OWNER/$REPO" \
    --state open \
    --search "dedupe-key:$DEDUPE_KEY in:body" \
    --json number,url,title,state \
    --limit 1 2>/dev/null || echo "[]")"
  DEDUPE_NUMBER="$(echo "$EXISTING_DEDUPE_ISSUE" | jq -r '.[0].number // empty' 2>/dev/null || true)"
  if [[ -n "$DEDUPE_NUMBER" ]]; then
    DEDUPE_URL="$(echo "$EXISTING_DEDUPE_ISSUE" | jq -r '.[0].url')"
    DEDUPE_TITLE="$(echo "$EXISTING_DEDUPE_ISSUE" | jq -r '.[0].title')"
    echo "Found existing open issue #$DEDUPE_NUMBER by dedupe-key ($DEDUPE_KEY) — skipping creation" >&2
    jq -n \
      --arg sid "$SESSION_ID" \
      --argjson num "$DEDUPE_NUMBER" \
      --arg title "$DEDUPE_TITLE" \
      --arg url "$DEDUPE_URL" \
      --arg project_slug "$PROJECT_SLUG" \
      --arg project_channel_id "$PROJECT_CHANNEL_ID" \
      --arg labels "Planning" \
      --arg dedupe_key "$DEDUPE_KEY" \
      --argjson factory_change "$([[ "$FACTORY_CHANGE_FROM_SPEC" == "true" ]] && echo "true" || echo "false")" \
      --argjson spec "$SPEC" \
      --argjson cls "$CLASSIFICATION" \
      --argjson interview "$INTERVIEW" \
      --argjson impact "$IMPACT" \
      --argjson qa "$QA_CONTRACT" \
      --argjson sec "$SECURITY" \
      --argjson map "$PROJECT_MAP" \
      --argjson meta "$METADATA" \
      '{
        session_id: $sid,
        step: "create_task",
        duplicate_prevented: true,
        duplicate_reason: "dedupe-key",
        dedupe_key: $dedupe_key,
        factory_change: $factory_change,
        project_slug: (if $project_slug != "" then $project_slug else null end),
        project_channel_id: (if $project_channel_id != "" then $project_channel_id else null end),
        issues: [{
          number: $num,
          title: $title,
          url: $url,
          labels: ($labels | split(",")),
          state: "open"
        }],
        spec: $spec,
        classification: $cls,
        interview: $interview,
        impact: $impact,
        qa_contract: $qa,
        security: $sec,
        project_map: $map,
        metadata: $meta
      }'
    exit 0
  fi
fi

# Build issue body using template-like expansion
BACKLOG_LABEL="$(genesis_backlog_label_from_input "$INPUT" "$TYPE")"
BACKLOG_METADATA_JSON="$(genesis_backlog_metadata_json "$INPUT" "$PROJECT_SLUG" "$TYPE")"
if [[ -z "$BACKLOG_METADATA_JSON" || "$BACKLOG_METADATA_JSON" == "null" ]]; then
  BACKLOG_METADATA_JSON="$(jq -cn --arg series "${PROJECT_SLUG:-genesis-default}" '{series: $series, order: 10, dependsOn: [], supersededBy: null}')"
fi
METADATA="$(printf '%s' "$METADATA" | jq -c --arg label "$BACKLOG_LABEL" --argjson backlog "$BACKLOG_METADATA_JSON" '
  (. // {}) + {backlog: (($backlog + {label: $label}) | with_entries(select(.value != "")))}
')"
BODY="## Objetivo

$OBJECTIVE

## Tipo de Entrega

$DELIVERY_TARGET

## Escopo V1

$(echo "$SPEC" | jq -r '.scope_v1 // [] | .[] | "- " + .')

## Fora de Escopo

$(echo "$SPEC" | jq -r '.out_of_scope // [] | .[] | "- " + .')

## Acceptance Criteria

$(echo "$SPEC" | jq -r '.acceptance_criteria // [] | .[] | "- [ ] " + .')

## Definition of Done

$(echo "$SPEC" | jq -r '.definition_of_done // [] | .[] | "- [ ] " + .')

## Restrições

$CONSTRAINTS"

if [[ -n "$DEDUPE_KEY" ]]; then
  BODY="$BODY

<!-- dedupe-key:$DEDUPE_KEY -->"
fi

BODY="$BODY

<!-- fabrica-backlog: $BACKLOG_METADATA_JSON -->"

# Add risks if present
RISKS="$(echo "$SPEC" | jq -r '.risks // [] | .[]')"
if [[ -n "$RISKS" ]]; then
  BODY="$BODY

## Riscos

$(echo "$SPEC" | jq -r '.risks[] | "- " + .')"
fi

# Add security notes if present
SEC_NOTES="$(echo "$SECURITY" | jq -r '.spec_security_notes // [] | .[]')"
if [[ -n "$SEC_NOTES" ]]; then
  BODY="$BODY

## Security Notes

$(echo "$SECURITY" | jq -r '.spec_security_notes[] | "- " + .')"
fi

BODY="$BODY

---
_Generated by Genesis Flow | Session: ${SESSION_ID}_"

# Determine labels
DELIVERY_LABEL="delivery:implementation"
if [[ "$TYPE" == "research" ]]; then
  DELIVERY_LABEL="delivery:research"
fi
LABELS="Planning,type:$TYPE,$DELIVERY_LABEL"
EXTRA_LABELS="type:$TYPE,$DELIVERY_LABEL"
LABELS="$LABELS,$BACKLOG_LABEL"
EXTRA_LABELS="$EXTRA_LABELS,$BACKLOG_LABEL"
if [[ "$TYPE" == "research" ]]; then
  LABELS="$LABELS,no-pr-required"
  EXTRA_LABELS="$EXTRA_LABELS,no-pr-required"
fi
SEC_REC="$(echo "$SECURITY" | jq -r '.recommendation // ""')"
if [[ "$SEC_REC" == HIGH* ]]; then
  LABELS="$LABELS,security:high"
  EXTRA_LABELS="$EXTRA_LABELS,security:high"
fi
FACTORY_CHANGE="$FACTORY_CHANGE_FROM_SPEC"
FACTORY_CHANGE_FLAG=()
if printf '%s\n%s\n' "$TITLE" "$BODY" | tr '[:upper:]' '[:lower:]' | grep -Eq 'factory|openclaw|devclaw|workflow|pipeline|orchestr'; then
  FACTORY_CHANGE=true
  FACTORY_CHANGE_FLAG=(--factory-change)
fi

echo "Creating issue: '$TITLE' with labels: $LABELS" >&2

ISSUE_NUMBER="0"
ISSUE_URL=""
if [[ "$USE_FABRICA_TASKS" == "true" ]]; then
  echo "Creating issue via deterministic DevClaw task_create..." >&2
  BODY_FILE="$(mktemp)"
  printf '%s\n' "$BODY" > "$BODY_FILE"
  TASK_CREATE_CMD=(create --project "$PROJECT_SLUG" --title "$TITLE" --body-file "$BODY_FILE")
  if [[ -n "$PROJECT_CHANNEL_ID" ]]; then
    TASK_CREATE_CMD+=(--channel-id "$PROJECT_CHANNEL_ID")
  fi
  if [[ "${#FACTORY_CHANGE_FLAG[@]}" -gt 0 ]]; then
    TASK_CREATE_CMD+=("${FACTORY_CHANGE_FLAG[@]}")
  fi
  TASK_CREATE_JSON="$(
    genesis_fabrica_task_json \
      "${TASK_CREATE_CMD[@]}" \
      2>>"$GENESIS_LOG"
  )" || {
    rm -f "$BODY_FILE"
    echo "ERROR: DevClaw task_create failed" >&2
    exit 1
  }
  rm -f "$BODY_FILE"

  ISSUE_NUMBER="$(echo "$TASK_CREATE_JSON" | jq -r '.issue.id // 0' 2>/dev/null || echo 0)"
  ISSUE_URL="$(echo "$TASK_CREATE_JSON" | jq -r '.issue.url // ""' 2>/dev/null || echo "")"
  if [[ "$ISSUE_NUMBER" != "0" && -n "$EXTRA_LABELS" ]]; then
    echo "Applying extra labels via deterministic DevClaw task labels: $EXTRA_LABELS" >&2
    TASK_LABELS_CMD=(labels --project "$PROJECT_SLUG" --issue-id "$ISSUE_NUMBER" --add "$EXTRA_LABELS")
    if [[ -n "$PROJECT_CHANNEL_ID" ]]; then
      TASK_LABELS_CMD+=(--channel-id "$PROJECT_CHANNEL_ID")
    fi
    if [[ "${#FACTORY_CHANGE_FLAG[@]}" -gt 0 ]]; then
      TASK_LABELS_CMD+=("${FACTORY_CHANGE_FLAG[@]}")
    fi
    genesis_fabrica_task_json \
      "${TASK_LABELS_CMD[@]}" \
      >/dev/null 2>>"$GENESIS_LOG" || {
        echo "ERROR: DevClaw task labels failed" >&2
        exit 1
      }
  fi
else
  echo "DevClaw deterministic mode unavailable (missing project slug/channel or openclaw bin); falling back to gh issue create." >&2
  gh label create "$DELIVERY_LABEL" --repo "$OWNER/$REPO" --color 5319E7 --force >/dev/null 2>>"$GENESIS_LOG" || true
  gh label create "$BACKLOG_LABEL" --repo "$OWNER/$REPO" --color BFD4F2 --force >/dev/null 2>>"$GENESIS_LOG" || true
  if [[ "$TYPE" == "research" ]]; then
    gh label create "no-pr-required" --repo "$OWNER/$REPO" --color 0e8a16 --force >/dev/null 2>>"$GENESIS_LOG" || true
  fi
  ISSUE_OUTPUT="$(gh issue create \
    --repo "$OWNER/$REPO" \
    --title "$TITLE" \
    --body "$BODY" \
    --label "$LABELS" \
    2>&1)" || {
    echo "ERROR: gh issue create failed: $ISSUE_OUTPUT" >&2
    exit 1
  }

  ISSUE_URL="$(printf '%s\n' "$ISSUE_OUTPUT" | grep -Eo 'https://github\.com/[^[:space:]]+/issues/[0-9]+' | head -1 || true)"
  ISSUE_NUMBER="$(printf '%s' "$ISSUE_URL" | grep -Eo '/issues/[0-9]+' | tr -dc '0-9' || true)"
  if [[ -z "$ISSUE_NUMBER" ]]; then
    ISSUE_NUMBER="0"
  fi
fi

if [[ "$ISSUE_NUMBER" == "0" || -z "$ISSUE_URL" ]]; then
  # Fallback: refetch by session marker to avoid abort on parser mismatch.
  REFETCH_ISSUE="$(gh issue list \
    --repo "$OWNER/$REPO" \
    --state all \
    --search "Session: $SESSION_ID in:body" \
    --json number,url \
    --limit 1 2>/dev/null || echo "[]")"
  ISSUE_NUMBER="$(echo "$REFETCH_ISSUE" | jq -r '.[0].number // 0')"
  ISSUE_URL="$(echo "$REFETCH_ISSUE" | jq -r '.[0].url // ""')"
fi

if [[ "$ISSUE_NUMBER" == "0" || -z "$ISSUE_URL" ]]; then
  echo "ERROR: Could not resolve created issue number/url" >&2
  exit 1
fi

echo "Created issue #$ISSUE_NUMBER: $ISSUE_URL" >&2

# Add QA contract as a comment
QA_SCRIPT="$(echo "$QA_CONTRACT" | jq -r '.script_content // ""')"
if [[ -n "$QA_SCRIPT" ]] && [[ "$QA_SCRIPT" != "null" ]]; then
  echo "Attaching QA contract as comment..." >&2
  QA_COMMENT="## QA Contract (scripts/qa.sh)

\`\`\`bash
$QA_SCRIPT
\`\`\`

**Gates:** $(echo "$QA_CONTRACT" | jq -r '.gates // [] | join(", ")')
**Coverage threshold:** $(echo "$QA_CONTRACT" | jq -r '.coverage_threshold // 80')%"

  if [[ "$USE_FABRICA_TASKS" == "true" ]]; then
    echo "QA comment via DevClaw task_comment..." >&2
    QA_COMMENT_FILE="$(mktemp)"
    printf '%s\n' "$QA_COMMENT" > "$QA_COMMENT_FILE"
    TASK_COMMENT_QA_CMD=(comment --project "$PROJECT_SLUG" --issue-id "$ISSUE_NUMBER" --body-file "$QA_COMMENT_FILE")
    if [[ -n "$PROJECT_CHANNEL_ID" ]]; then
      TASK_COMMENT_QA_CMD+=(--channel-id "$PROJECT_CHANNEL_ID")
    fi
    genesis_fabrica_task_json \
      "${TASK_COMMENT_QA_CMD[@]}" \
      >/dev/null 2>>"$GENESIS_LOG" || echo "WARNING: Failed to attach QA comment via task_comment" >&2
    rm -f "$QA_COMMENT_FILE"
  else
    echo "QA comment via gh issue comment..." >&2
    gh issue comment "$ISSUE_NUMBER" \
      --repo "$OWNER/$REPO" \
      --body "$QA_COMMENT" >/dev/null 2>>"$GENESIS_LOG" || echo "WARNING: Failed to attach QA comment" >&2
  fi
  echo "QA comment step finished." >&2
fi

# Attach map/impact summary as a comment (compact; avoid dumping huge JSON).
FILES_SCANNED="$(echo "$PROJECT_MAP" | jq -r '.stats.files_scanned // 0' 2>/dev/null || echo 0)"
SYMBOLS_FOUND="$(echo "$PROJECT_MAP" | jq -r '.stats.symbols_found // 0' 2>/dev/null || echo 0)"
LANGUAGES="$(echo "$PROJECT_MAP" | jq -r '.stats.languages // [] | join(", ")' 2>/dev/null || echo "")"
MAP_ROOT="$(echo "$PROJECT_MAP" | jq -r '.root // ""' 2>/dev/null || echo "")"

IS_GREENFIELD="$(echo "$IMPACT" | jq -r '.is_greenfield // false' 2>/dev/null || echo false)"
ESTIMATED_CHANGED="$(echo "$IMPACT" | jq -r '.estimated_files_changed // ""' 2>/dev/null || echo "")"
RISK_AREAS="$(echo "$IMPACT" | jq -r '.risk_areas // [] | .[:10] | .[]' 2>/dev/null || true)"
NEW_FILES="$(echo "$IMPACT" | jq -r '.new_files_needed // [] | .[:10] | .[]' 2>/dev/null || true)"
AFFECTED_FILES="$(echo "$IMPACT" | jq -r '.affected_files // [] | .[:25] | .[]' 2>/dev/null || true)"

MAP_HAS_SIGNAL=false
if [[ "$FILES_SCANNED" != "0" || "$SYMBOLS_FOUND" != "0" || -n "$LANGUAGES" || -n "$MAP_ROOT" ]]; then
  MAP_HAS_SIGNAL=true
fi

IMPACT_HAS_SIGNAL=false
if [[ -n "$ESTIMATED_CHANGED" || -n "$RISK_AREAS" || -n "$NEW_FILES" || -n "$AFFECTED_FILES" ]]; then
  IMPACT_HAS_SIGNAL=true
fi

if $MAP_HAS_SIGNAL || $IMPACT_HAS_SIGNAL; then
  echo "Attaching map/impact summary as comment..." >&2

  MAP_LINES=""
  if [[ -n "$MAP_ROOT" ]]; then
    MAP_LINES="$MAP_LINES\n**Map root:** $MAP_ROOT"
  fi
  MAP_LINES="$MAP_LINES\n**Map stats:** files_scanned=$FILES_SCANNED, symbols_found=$SYMBOLS_FOUND"
  if [[ -n "$LANGUAGES" ]]; then
    MAP_LINES="$MAP_LINES\n**Languages:** $LANGUAGES"
  fi

  IMPACT_LINES="\n**Greenfield:** $IS_GREENFIELD"
  if [[ -n "$ESTIMATED_CHANGED" ]]; then
    IMPACT_LINES="$IMPACT_LINES\n**Estimated files changed:** $ESTIMATED_CHANGED"
  fi

  LIST_BLOCKS=""
  if [[ -n "$AFFECTED_FILES" ]]; then
    LIST_BLOCKS="$LIST_BLOCKS\n\n### Affected files (top 25)\n$(printf '%s\n' "$AFFECTED_FILES" | sed 's/^/- /')\n"
  fi
  if [[ -n "$NEW_FILES" ]]; then
    LIST_BLOCKS="$LIST_BLOCKS\n\n### New files needed (top 10)\n$(printf '%s\n' "$NEW_FILES" | sed 's/^/- /')\n"
  fi
  if [[ -n "$RISK_AREAS" ]]; then
    LIST_BLOCKS="$LIST_BLOCKS\n\n### Risk areas (top 10)\n$(printf '%s\n' "$RISK_AREAS" | sed 's/^/- /')\n"
  fi

  IMPACT_COMMENT="## Map/Impact Summary
$MAP_LINES

$IMPACT_LINES
$LIST_BLOCKS"

  if [[ "$USE_FABRICA_TASKS" == "true" ]]; then
    echo "Map/impact comment via DevClaw task_comment..." >&2
    IMPACT_COMMENT_FILE="$(mktemp)"
    printf '%s\n' "$IMPACT_COMMENT" > "$IMPACT_COMMENT_FILE"
    TASK_COMMENT_IMPACT_CMD=(comment --project "$PROJECT_SLUG" --issue-id "$ISSUE_NUMBER" --body-file "$IMPACT_COMMENT_FILE")
    if [[ -n "$PROJECT_CHANNEL_ID" ]]; then
      TASK_COMMENT_IMPACT_CMD+=(--channel-id "$PROJECT_CHANNEL_ID")
    fi
    genesis_fabrica_task_json \
      "${TASK_COMMENT_IMPACT_CMD[@]}" \
      >/dev/null 2>>"$GENESIS_LOG" || echo "WARNING: Failed to attach impact/map comment via task_comment" >&2
    rm -f "$IMPACT_COMMENT_FILE"
  else
    echo "Map/impact comment via gh issue comment..." >&2
    gh issue comment "$ISSUE_NUMBER" \
      --repo "$OWNER/$REPO" \
      --body "$IMPACT_COMMENT" >/dev/null 2>>"$GENESIS_LOG" || echo "WARNING: Failed to attach impact/map comment" >&2
  fi
  echo "Map/impact comment step finished." >&2
fi

echo "create-task.sh completed for session $SESSION_ID" >&2

jq -n \
  --arg sid "$SESSION_ID" \
  --argjson num "$ISSUE_NUMBER" \
  --arg title "$TITLE" \
  --arg url "$ISSUE_URL" \
  --arg project_slug "$PROJECT_SLUG" \
  --arg project_channel_id "$PROJECT_CHANNEL_ID" \
  --arg labels "$LABELS" \
  --argjson factory_change "$([[ "$FACTORY_CHANGE" == "true" ]] && echo "true" || echo "false")" \
  --argjson spec "$SPEC" \
  --argjson cls "$CLASSIFICATION" \
  --argjson interview "$INTERVIEW" \
  --argjson impact "$IMPACT" \
  --argjson qa "$QA_CONTRACT" \
  --argjson sec "$SECURITY" \
  --argjson map "$PROJECT_MAP" \
  --argjson meta "$METADATA" \
  '{
    session_id: $sid,
    step: "create_task",
    factory_change: $factory_change,
    project_slug: (if $project_slug != "" then $project_slug else null end),
    project_channel_id: (if $project_channel_id != "" then $project_channel_id else null end),
    issues: [{
      number: $num,
      title: $title,
      url: $url,
      labels: ($labels | split(",")),
      state: "open"
    }],
    spec: $spec,
    classification: $cls,
    interview: $interview,
    impact: $impact,
    qa_contract: $qa,
    security: $sec,
    project_map: $map,
    metadata: $meta
  }'

genesis_metric_end "ok"
