#!/usr/bin/env bash
set -euo pipefail

# Step 10: Triage — prioritize and dispatch issue to Fabrica pipeline
# Input: stdin JSON (issue data + spec)
# Output: JSON with triage decision to stdout
# Applies labels + workflow transitions to dispatch Fabrica safely

GENESIS_LOG="${GENESIS_LOG:-$HOME/.openclaw/workspace/logs/genesis.log}"
mkdir -p "$(dirname "$GENESIS_LOG")"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRIAGE_MATRIX="$SCRIPT_DIR/../configs/triage-matrix.json"
source "$SCRIPT_DIR/sideband-lib.sh"
source "$SCRIPT_DIR/genesis-telemetry.sh"

# Load .env if available
genesis_load_env_file "$HOME/.openclaw/.env"

if [[ -n "${1:-}" && -f "${1:-}" ]]; then
  INPUT="$(cat "$1")"
else
  INPUT="$(cat)"
fi
TARGET_RESOLUTION="$(genesis_resolve_canonical_target "$INPUT" || jq -n '{metadata:{}}')"
INPUT="$(printf '%s' "$INPUT" | jq --argjson resolved "$TARGET_RESOLUTION" '
  .metadata = ((.metadata // {}) + ($resolved.metadata // {}))
')"
if ! printf '%s' "$INPUT" | jq -e . >/dev/null 2>&1; then
  echo "ERROR: triage received non-JSON input (likely previous step leaked stdout)" >&2
  exit 1
fi
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id')"
genesis_metric_start "triage" "$SESSION_ID"
SPEC="$(echo "$INPUT" | jq '.spec // {}')"
ISSUES="$(echo "$INPUT" | jq '.issues // []')"
IMPACT="$(echo "$INPUT" | jq '.impact // {}')"
SECURITY="$(echo "$INPUT" | jq '.security // {}')"
DRY_RUN="$(echo "$INPUT" | jq -r '.dry_run // false')"
SPEC_TYPE="$(echo "$INPUT" | jq -r '.spec.type // "feature"')"
SPEC_DELIVERY_TARGET="$(echo "$INPUT" | jq -r '.spec.delivery_target // "unknown"')"

if ! echo "$SPEC" | jq -e 'type == "object"' >/dev/null 2>&1; then
  echo "ERROR: triage spec payload must be an object" >&2
  exit 1
fi
if ! echo "$ISSUES" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "ERROR: triage issues payload must be an array" >&2
  exit 1
fi

echo "Running triage for session $SESSION_ID..." >&2

# Dry-run mode: keep pipeline deterministic without touching labels.
if [[ "$DRY_RUN" == "true" ]]; then
  echo "$INPUT" | jq '. + {
    step: "triage",
    triage: {
      skipped: true,
      reason: "dry_run",
      ready_for_dispatch: false,
      errors: []
    }
  }'
  exit 0
fi

# Get issue number
ISSUE_NUMBER="$(echo "$ISSUES" | jq -r '.[0].number // 0')"
if [[ "$ISSUE_NUMBER" == "0" ]]; then
  echo "ERROR: No issue number found in input" >&2
  exit 1
fi

# Determine repo (prefer current pipeline state; avoid implicit default target for product flows)
REPO_URL="$(echo "$INPUT" | jq -r '.scaffold.repo_url // .metadata.repo_url // ""')"

# Sideband: if scaffold created a new repo, use that (validated + TTL-bound)
SCAFFOLD_PAYLOAD="$(genesis_sideband_read_payload "scaffold" "$SESSION_ID" "${GENESIS_SIDEBAND_TTL_SECONDS:-1800}" || true)"
if [[ -z "$REPO_URL" && -n "$SCAFFOLD_PAYLOAD" ]]; then
  SCAFFOLD_REPO="$(echo "$SCAFFOLD_PAYLOAD" | jq -r '.scaffold.repo_url // empty')"
  if [[ -n "$SCAFFOLD_REPO" ]]; then
    REPO_URL="$SCAFFOLD_REPO"
    echo "Using scaffolded repo URL for triage: $REPO_URL" >&2
  fi
fi

CANDIDATE_PROJECT_SLUG="$(echo "$INPUT" | jq -r '.project_slug // .metadata.project_slug // .scaffold.project_slug // empty')"
if [[ -z "$CANDIDATE_PROJECT_SLUG" || "$CANDIDATE_PROJECT_SLUG" == "null" ]]; then
  CANDIDATE_PROJECT_SLUG="$(echo "$INPUT" | jq -r '.metadata.project_name // empty')"
fi
REQUESTED_CHANNEL_ID="$(echo "$INPUT" | jq -r '.project_channel_id // empty')"
PROJECT_SLUG=""

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
if [[ -n "$REPO_URL" && "$REPO_URL" == "~"* ]]; then
  REPO_URL="$(genesis_expand_path "$REPO_URL")"
fi
if [[ -z "$REPO_URL" ]]; then
  echo "ERROR: No repo URL resolved from pipeline state for triage (scaffold/metadata)." >&2
  exit 1
fi

if [[ -n "$REPO_URL" ]] && ! genesis_parse_owner_repo "$REPO_URL" >/dev/null 2>&1; then
  PROJECT_REF="$(genesis_project_resolve_ref "$REPO_URL" || true)"
  if [[ -n "$PROJECT_REF" ]]; then
    PROJECT_SLUG="$(printf '%s' "$PROJECT_REF" | cut -f1)"
    RESOLVED_REMOTE="$(printf '%s' "$PROJECT_REF" | cut -f3)"
    if [[ -n "$RESOLVED_REMOTE" ]]; then
      REPO_URL="$RESOLVED_REMOTE"
    fi
  fi
fi

OWNER_REPO="$(genesis_parse_owner_repo "$REPO_URL" || true)"
if [[ -z "$OWNER_REPO" ]]; then
  echo "ERROR: Invalid GitHub repository reference: $REPO_URL" >&2
  exit 1
fi

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
  echo "ERROR: Target project \"$PROJECT_SLUG\" is archived and cannot be triaged or dispatched." >&2
  exit 1
fi

if [[ "$PROJECT_KIND" == "pointer" ]] && [[ "$SPEC_TYPE" != "research" ]]; then
  echo "ERROR: Target project \"$PROJECT_SLUG\" is marked as pointer/scaffold and cannot receive implementation dispatch." >&2
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

if [[ ! -f "$TRIAGE_MATRIX" ]]; then
  echo "ERROR: Missing triage matrix file: $TRIAGE_MATRIX" >&2
  exit 1
fi

TYPE="$(echo "$SPEC" | jq -r '.type // "feature"')"
TITLE="$(echo "$SPEC" | jq -r '.title // ""')"
AC_COUNT="$(echo "$SPEC" | jq '.acceptance_criteria // [] | length')"
SCOPE_COUNT="$(echo "$SPEC" | jq '.scope_v1 // [] | length')"
DOD_COUNT="$(echo "$SPEC" | jq '.definition_of_done // [] | length')"
DELIVERY_TARGET="$(echo "$SPEC" | jq -r '.delivery_target // "unknown"')"
OBJECTIVE_RAW="$(echo "$SPEC" | jq -r '.objective // ""')"
OBJECTIVE="$(genesis_trim "$OBJECTIVE_RAW")"
OBJECTIVE_LOWER="$(printf '%s' "$OBJECTIVE" | tr '[:upper:]' '[:lower:]')"
RAW_IDEA_LOWER="$(echo "$INPUT" | jq -r '.raw_idea // ""' | tr '[:upper:]' '[:lower:]')"
META_AUTH_SIGNAL="$(echo "$INPUT" | jq -r '.metadata.auth_gate.signal // false')"
FACTORY_CHANGE_RAW="$(echo "$INPUT" | jq -r '.factory_change // false')"
FACTORY_CHANGE=false
if [[ "$FACTORY_CHANGE_RAW" == "true" ]]; then
  FACTORY_CHANGE=true
elif printf '%s\n%s\n' "$TITLE" "$OBJECTIVE" | tr '[:upper:]' '[:lower:]' | grep -Eq 'factory|openclaw|devclaw|workflow|pipeline|orchestr'; then
  FACTORY_CHANGE=true
fi
FILES_CHANGED="$(echo "$IMPACT" | jq '.estimated_files_changed // 0')"
RISK_COUNT="$(echo "$IMPACT" | jq '.risk_areas // [] | length')"
SEC_NOTES="$(echo "$SECURITY" | jq '.spec_security_notes // [] | length')"
TOTAL_RISKS=$((RISK_COUNT + SEC_NOTES))

echo "Type=$TYPE, ACs=$AC_COUNT, Files=$FILES_CHANGED, Risks=$TOTAL_RISKS" >&2

# Calculate effort
EFFORT="medium"
if [[ "$FILES_CHANGED" -le 3 ]] && [[ "$AC_COUNT" -le 3 ]]; then
  EFFORT="small"
elif [[ "$FILES_CHANGED" -le 10 ]] && [[ "$AC_COUNT" -le 7 ]]; then
  EFFORT="medium"
elif [[ "$FILES_CHANGED" -le 25 ]] && [[ "$AC_COUNT" -le 15 ]]; then
  EFFORT="large"
else
  EFFORT="xlarge"
fi

EFFORT_LABEL="$(jq -r --arg e "$EFFORT" '.effort_rules[$e].label // empty' "$TRIAGE_MATRIX")"

# Calculate priority (walk the rules in order, first match wins)
PRIORITY="P3"
PRIORITY_LABEL="priority:normal"
PRIORITY_MATCHED=false

while IFS= read -r rule; do
  [[ -n "$rule" ]] || continue
  RULE_TYPE="$(echo "$rule" | jq -r '.when.type // empty')"
  RULE_EFFORT="$(echo "$rule" | jq -r '.when.effort // empty')"
  RULE_MIN_RISK="$(echo "$rule" | jq -r '.when.min_risk_count // empty')"
  RULE_MAX_RISK="$(echo "$rule" | jq -r '.when.max_risk_count // empty')"
  RULE_PRIORITY="$(echo "$rule" | jq -r '.priority // empty')"
  RULE_LABEL="$(echo "$rule" | jq -r '.label // empty')"

  [[ -n "$RULE_PRIORITY" && -n "$RULE_LABEL" ]] || continue
  [[ -z "$RULE_TYPE" || "$RULE_TYPE" == "$TYPE" ]] || continue
  [[ -z "$RULE_EFFORT" || "$RULE_EFFORT" == "$EFFORT" ]] || continue
  if [[ -n "$RULE_MIN_RISK" && "$RULE_MIN_RISK" != "null" ]]; then
    [[ "$TOTAL_RISKS" -ge "$RULE_MIN_RISK" ]] || continue
  fi
  if [[ -n "$RULE_MAX_RISK" && "$RULE_MAX_RISK" != "null" ]]; then
    [[ "$TOTAL_RISKS" -le "$RULE_MAX_RISK" ]] || continue
  fi

  PRIORITY="$RULE_PRIORITY"
  PRIORITY_LABEL="$RULE_LABEL"
  PRIORITY_MATCHED=true
  break
done < <(jq -c '.priority_rules_v2 // [] | .[]' "$TRIAGE_MATRIX")

if [[ "$PRIORITY_MATCHED" != "true" ]]; then
  if [[ "$TYPE" == "bugfix" ]] && [[ "$TOTAL_RISKS" -gt 2 ]]; then
    PRIORITY="P0"; PRIORITY_LABEL="priority:critical"
  elif [[ "$TYPE" == "bugfix" ]]; then
    PRIORITY="P1"; PRIORITY_LABEL="priority:high"
  elif [[ "$TYPE" == "infra" ]]; then
    PRIORITY="P2"; PRIORITY_LABEL="priority:medium"
  elif [[ "$TYPE" == "feature" ]] && [[ "$EFFORT" == "small" ]]; then
    PRIORITY="P2"; PRIORITY_LABEL="priority:medium"
  elif [[ "$TYPE" == "feature" ]]; then
    PRIORITY="P3"; PRIORITY_LABEL="priority:normal"
  else
    PRIORITY="P3"; PRIORITY_LABEL="priority:normal"
  fi
fi

# Get type label
TYPE_LABEL="$(jq -r --arg t "$TYPE" '.auto_labels[$t] // empty' "$TRIAGE_MATRIX")"
DISPATCH_LABEL="$(jq -r '.dispatch_label // empty' "$TRIAGE_MATRIX")"

if [[ -z "$EFFORT_LABEL" || -z "$PRIORITY_LABEL" || -z "$DISPATCH_LABEL" ]]; then
  echo "ERROR: Invalid triage matrix labels (effort/priority/dispatch)" >&2
  exit 1
fi

echo "Triage: $PRIORITY ($PRIORITY_LABEL), effort=$EFFORT ($EFFORT_LABEL)" >&2

READY_FOR_DISPATCH=true
TRIAGE_ERRORS=()
DISPATCH_STAGE_APPLIED=false
LEVEL_LABEL_APPLIED=false
TARGET_TRANSITIONED=false

# Definition of Ready (DoR) gate: fail-closed before dispatch.
if [[ -z "$OBJECTIVE" ]]; then
  READY_FOR_DISPATCH=false
  TRIAGE_ERRORS+=("dor_missing_objective")
fi
if [[ "$SCOPE_COUNT" -lt 1 ]]; then
  READY_FOR_DISPATCH=false
  TRIAGE_ERRORS+=("dor_missing_scope")
fi
if [[ "$AC_COUNT" -lt 1 ]]; then
  READY_FOR_DISPATCH=false
  TRIAGE_ERRORS+=("dor_missing_acceptance_criteria")
fi
if [[ "$DOD_COUNT" -lt 1 ]]; then
  READY_FOR_DISPATCH=false
  TRIAGE_ERRORS+=("dor_missing_definition_of_done")
fi
AC_LOWER="$(echo "$SPEC" | jq -r '.acceptance_criteria // [] | join(" ")' | tr '[:upper:]' '[:lower:]')"
SCOPE_LOWER="$(echo "$SPEC" | jq -r '.scope_v1 // [] | join(" ")' | tr '[:upper:]' '[:lower:]')"
OOS_LOWER="$(echo "$SPEC" | jq -r '.out_of_scope // [] | join(" ")' | tr '[:upper:]' '[:lower:]')"
if [[ "$DELIVERY_TARGET" == "web-ui" ]]; then
  if ! echo "$AC_LOWER $SCOPE_LOWER" | grep -Eqi '\b(tela|página|pagina|ui|interface|dashboard|fluxo)\b'; then
    READY_FOR_DISPATCH=false
    TRIAGE_ERRORS+=("dor_web_ui_missing_ui_evidence")
  fi
fi
if [[ "$DELIVERY_TARGET" == "api" ]]; then
  if ! echo "$AC_LOWER $SCOPE_LOWER" | grep -Eqi '\b(api|endpoint|rota|route|http|rest)\b'; then
    READY_FOR_DISPATCH=false
    TRIAGE_ERRORS+=("dor_api_missing_endpoint_evidence")
  fi
fi
if [[ "$DELIVERY_TARGET" == "hybrid" ]]; then
  if ! echo "$AC_LOWER $SCOPE_LOWER" | grep -Eqi '\b(tela|página|pagina|ui|interface|dashboard|fluxo)\b'; then
    READY_FOR_DISPATCH=false
    TRIAGE_ERRORS+=("dor_hybrid_missing_ui_evidence")
  fi
  if ! echo "$AC_LOWER $SCOPE_LOWER" | grep -Eqi '\b(api|endpoint|rota|route|http|rest)\b'; then
    READY_FOR_DISPATCH=false
    TRIAGE_ERRORS+=("dor_hybrid_missing_api_evidence")
  fi
fi

# Auth critical requirements gate.
AUTH_REGEX='\b(login|autentic|senha|perfil|permiss|acesso|rbac|admin)\b'
AUTH_SIGNAL=false
if [[ "$META_AUTH_SIGNAL" == "true" ]]; then
  AUTH_SIGNAL=true
elif echo "$RAW_IDEA_LOWER $OBJECTIVE_LOWER" | grep -Eqi "$AUTH_REGEX"; then
  AUTH_SIGNAL=true
fi
if [[ "$AUTH_SIGNAL" == "true" ]]; then
  if ! echo "$AC_LOWER $SCOPE_LOWER $OBJECTIVE_LOWER" | grep -Eqi "$AUTH_REGEX"; then
    READY_FOR_DISPATCH=false
    TRIAGE_ERRORS+=("dor_auth_requirements_missing")
  fi
  if echo "$OOS_LOWER" | grep -Eqi "$AUTH_REGEX" && ! echo "$AC_LOWER" | grep -Eqi "$AUTH_REGEX"; then
    READY_FOR_DISPATCH=false
    TRIAGE_ERRORS+=("dor_auth_moved_to_out_of_scope_without_acceptance")
  fi
fi

# Route by type (config-driven).
TARGET_QUEUE_LABEL="$(jq -r --arg t "$TYPE" '.target_state_by_type[$t] // .target_state_by_type.default // "To Do"' "$TRIAGE_MATRIX")"
if [[ -z "$TARGET_QUEUE_LABEL" || "$TARGET_QUEUE_LABEL" == "null" ]]; then
  TARGET_QUEUE_LABEL="To Do"
fi

# Apply labels via gh
ALL_LABELS="$PRIORITY_LABEL,$EFFORT_LABEL"
[[ -n "$TYPE_LABEL" ]] && ALL_LABELS="$ALL_LABELS,$TYPE_LABEL"
if [[ "$READY_FOR_DISPATCH" != "true" ]]; then
  ALL_LABELS="$ALL_LABELS,needs-human"
fi

echo "Applying labels to issue #$ISSUE_NUMBER: $ALL_LABELS" >&2

if [[ "$USE_FABRICA_TASKS" == "true" ]]; then
  TASK_LABELS_CMD=(labels --project "$PROJECT_SLUG" --issue-id "$ISSUE_NUMBER" --add "$ALL_LABELS")
  if [[ -n "$PROJECT_CHANNEL_ID" ]]; then
    TASK_LABELS_CMD+=(--channel-id "$PROJECT_CHANNEL_ID")
  fi
  if [[ "$FACTORY_CHANGE" == "true" ]]; then
    TASK_LABELS_CMD+=(--factory-change)
  fi
  if ! genesis_fabrica_task_json "${TASK_LABELS_CMD[@]}" >/dev/null 2>>"$GENESIS_LOG"; then
    READY_FOR_DISPATCH=false
    TRIAGE_ERRORS+=("apply_labels_failed")
  fi
else
  if ! gh issue edit "$ISSUE_NUMBER" \
    --repo "$OWNER_REPO" \
    --add-label "$ALL_LABELS" >/dev/null 2>&1; then
    READY_FOR_DISPATCH=false
    TRIAGE_ERRORS+=("apply_labels_failed")
  else
    :
  fi
fi

if [[ "$READY_FOR_DISPATCH" != "true" ]]; then
  DOR_COMMENT="## Triage blocked by Definition of Ready

The issue stayed in **Planning** because required fields are missing:
$(printf '%s\n' "${TRIAGE_ERRORS[@]}" | sed 's/^/- /')
"
  if [[ "$USE_FABRICA_TASKS" == "true" ]]; then
    DOR_COMMENT_FILE="$(mktemp)"
    printf '%s\n' "$DOR_COMMENT" > "$DOR_COMMENT_FILE"
    TASK_DOR_CMD=(comment --project "$PROJECT_SLUG" --issue-id "$ISSUE_NUMBER" --body-file "$DOR_COMMENT_FILE")
    if [[ -n "$PROJECT_CHANNEL_ID" ]]; then
      TASK_DOR_CMD+=(--channel-id "$PROJECT_CHANNEL_ID")
    fi
    genesis_fabrica_task_json "${TASK_DOR_CMD[@]}" >/dev/null 2>>"$GENESIS_LOG" || true
    rm -f "$DOR_COMMENT_FILE"
  else
    gh issue comment "$ISSUE_NUMBER" --repo "$OWNER_REPO" --body "$DOR_COMMENT" >/dev/null 2>&1 || true
  fi
fi

echo "Issue #$ISSUE_NUMBER triaged (dispatch label '$DISPATCH_LABEL' requested)" >&2

# === Auto-transition: Planning → target queue ===
# Determine worker level from effort/complexity
LEVEL="medior"
if [[ "$EFFORT" == "small" ]]; then
  LEVEL="junior"
elif [[ "$EFFORT" == "large" ]] || [[ "$EFFORT" == "xlarge" ]]; then
  LEVEL="senior"
fi
if [[ "$TARGET_QUEUE_LABEL" == "To Research" && "$LEVEL" == "medior" ]]; then
  LEVEL="junior"
fi

if [[ "$READY_FOR_DISPATCH" == "true" && "$TARGET_QUEUE_LABEL" == "To Do" && "$USE_FABRICA_TASKS" == "true" ]]; then
  echo "Dispatching via deterministic Fabrica task_start (Planning → To Do, level=$LEVEL)..." >&2
  TASK_START_CMD=(start --project "$PROJECT_SLUG" --issue-id "$ISSUE_NUMBER" --level "$LEVEL")
  if [[ -n "$PROJECT_CHANNEL_ID" ]]; then
    TASK_START_CMD+=(--channel-id "$PROJECT_CHANNEL_ID")
  fi
  if [[ "$FACTORY_CHANGE" == "true" ]]; then
    TASK_START_CMD+=(--factory-change)
  fi
  if ! genesis_fabrica_task_json "${TASK_START_CMD[@]}" >/dev/null 2>>"$GENESIS_LOG"; then
    READY_FOR_DISPATCH=false
    TRIAGE_ERRORS+=("task_start_failed")
  else
    TARGET_TRANSITIONED=true
    LEVEL_LABEL_APPLIED=true
    DISPATCH_STAGE_APPLIED=true
  fi
elif [[ "$READY_FOR_DISPATCH" == "true" && "$USE_FABRICA_TASKS" == "true" ]]; then
  echo "Routing deterministically via Fabrica task route (Planning → $TARGET_QUEUE_LABEL, level=$LEVEL)..." >&2
  TASK_ROUTE_CMD=(route --project "$PROJECT_SLUG" --issue-id "$ISSUE_NUMBER" --to-label "$TARGET_QUEUE_LABEL")
  if [[ -n "$PROJECT_CHANNEL_ID" ]]; then
    TASK_ROUTE_CMD+=(--channel-id "$PROJECT_CHANNEL_ID")
  fi
  if [[ -n "$LEVEL" ]]; then
    TASK_ROUTE_CMD+=(--level "$LEVEL")
  fi
  if [[ "$FACTORY_CHANGE" == "true" ]]; then
    TASK_ROUTE_CMD+=(--factory-change)
  fi
  if ! genesis_fabrica_task_json "${TASK_ROUTE_CMD[@]}" >/dev/null 2>>"$GENESIS_LOG"; then
    READY_FOR_DISPATCH=false
    TRIAGE_ERRORS+=("task_route_failed")
  else
    TARGET_TRANSITIONED=true
    LEVEL_LABEL_APPLIED=true
  fi
else
  # Add developer level label (legacy gh path or non-deterministic fallback)
  if [[ "$READY_FOR_DISPATCH" == "true" && "$TARGET_QUEUE_LABEL" == "To Do" ]]; then
    echo "Setting developer level: developer:$LEVEL" >&2
  if ! gh issue edit "$ISSUE_NUMBER" \
    --repo "$OWNER_REPO" \
    --add-label "developer:$LEVEL" >/dev/null 2>>"$GENESIS_LOG"; then
      READY_FOR_DISPATCH=false
      TRIAGE_ERRORS+=("level_label_failed")
    else
      LEVEL_LABEL_APPLIED=true
    fi
  else
    echo "Skipping developer level label (target=$TARGET_QUEUE_LABEL, ready=$READY_FOR_DISPATCH)" >&2
  fi

  # Swap Planning → target queue (heartbeat will auto-dispatch workers)
  if [[ "$READY_FOR_DISPATCH" == "true" ]]; then
    echo "Transitioning issue #$ISSUE_NUMBER: Planning → $TARGET_QUEUE_LABEL" >&2

    TRANSITION_LABELS="$TARGET_QUEUE_LABEL"
    if [[ "$TARGET_QUEUE_LABEL" == "To Do" ]]; then
      TRANSITION_LABELS="$TRANSITION_LABELS,$DISPATCH_LABEL"
    fi

    if ! gh issue edit "$ISSUE_NUMBER" \
      --repo "$OWNER_REPO" \
      --remove-label "Planning" \
      --add-label "$TRANSITION_LABELS" >/dev/null 2>>"$GENESIS_LOG"; then
      CURRENT_LABELS="$(gh issue view "$ISSUE_NUMBER" --repo "$OWNER_REPO" --json labels --jq '.labels[].name' 2>/dev/null || true)"
      if echo "$CURRENT_LABELS" | grep -qxF "$TARGET_QUEUE_LABEL"; then
        TARGET_TRANSITIONED=true
        [[ "$TARGET_QUEUE_LABEL" == "To Do" ]] && DISPATCH_STAGE_APPLIED=true
      else
        READY_FOR_DISPATCH=false
        TRIAGE_ERRORS+=("planning_to_target_failed")
      fi
    else
      TARGET_TRANSITIONED=true
      [[ "$TARGET_QUEUE_LABEL" == "To Do" ]] && DISPATCH_STAGE_APPLIED=true
    fi
  else
    echo "Skipping Planning → target transition due to previous triage failure" >&2
  fi
fi

if [[ "$READY_FOR_DISPATCH" == "true" ]]; then
  if [[ "$USE_FABRICA_TASKS" == "true" ]]; then
    TASK_CLEAR_NEEDS_HUMAN_CMD=(labels --project "$PROJECT_SLUG" --issue-id "$ISSUE_NUMBER" --remove "needs-human")
    if [[ -n "$PROJECT_CHANNEL_ID" ]]; then
      TASK_CLEAR_NEEDS_HUMAN_CMD+=(--channel-id "$PROJECT_CHANNEL_ID")
    fi
    if [[ "$FACTORY_CHANGE" == "true" ]]; then
      TASK_CLEAR_NEEDS_HUMAN_CMD+=(--factory-change)
    fi
    genesis_fabrica_task_json "${TASK_CLEAR_NEEDS_HUMAN_CMD[@]}" >/dev/null 2>>"$GENESIS_LOG" || true
  else
    gh issue edit "$ISSUE_NUMBER" --repo "$OWNER_REPO" --remove-label "needs-human" >/dev/null 2>&1 || true
  fi
  echo "Issue #$ISSUE_NUMBER dispatched to $TARGET_QUEUE_LABEL (level=$LEVEL)" >&2
else
  echo "Issue #$ISSUE_NUMBER NOT dispatched; triage failed closed: ${TRIAGE_ERRORS[*]}" >&2
  if [[ "$USE_FABRICA_TASKS" == "true" ]]; then
    TASK_SET_NEEDS_HUMAN_CMD=(labels --project "$PROJECT_SLUG" --issue-id "$ISSUE_NUMBER" --add "needs-human")
    if [[ -n "$PROJECT_CHANNEL_ID" ]]; then
      TASK_SET_NEEDS_HUMAN_CMD+=(--channel-id "$PROJECT_CHANNEL_ID")
    fi
    if [[ "$FACTORY_CHANGE" == "true" ]]; then
      TASK_SET_NEEDS_HUMAN_CMD+=(--factory-change)
    fi
    if ! genesis_fabrica_task_json "${TASK_SET_NEEDS_HUMAN_CMD[@]}" >/dev/null 2>>"$GENESIS_LOG"; then
      TRIAGE_ERRORS+=("mark_needs_human_failed")
    fi
  elif ! gh issue edit "$ISSUE_NUMBER" --repo "$OWNER_REPO" --add-label "needs-human" >/dev/null 2>&1; then
    TRIAGE_ERRORS+=("mark_needs_human_failed")
  fi

  if [[ "$TARGET_TRANSITIONED" == "true" ]]; then
    if ! gh issue edit "$ISSUE_NUMBER" \
      --repo "$OWNER_REPO" \
      --remove-label "$TARGET_QUEUE_LABEL" \
      --add-label "Planning" >/dev/null 2>>"$GENESIS_LOG"; then
      TRIAGE_ERRORS+=("rollback_target_failed")
    fi
  fi

  ROLLBACK_REMOVE_LABELS=()
  if [[ "$LEVEL_LABEL_APPLIED" == "true" ]]; then
    ROLLBACK_REMOVE_LABELS+=("developer:$LEVEL")
  fi
  if [[ "$DISPATCH_STAGE_APPLIED" == "true" ]]; then
    ROLLBACK_REMOVE_LABELS+=("$DISPATCH_LABEL")
  fi

  if [[ "${#ROLLBACK_REMOVE_LABELS[@]}" -gt 0 ]]; then
    ROLLBACK_REMOVE_CSV="$(IFS=,; echo "${ROLLBACK_REMOVE_LABELS[*]}")"
    if ! gh issue edit "$ISSUE_NUMBER" \
      --repo "$OWNER_REPO" \
      --remove-label "$ROLLBACK_REMOVE_CSV" >/dev/null 2>>"$GENESIS_LOG"; then
      TRIAGE_ERRORS+=("rollback_labels_failed")
    fi
  fi
fi

# Cleanup sideband files
genesis_sideband_cleanup "$SESSION_ID"

if [[ "${#TRIAGE_ERRORS[@]}" -gt 0 ]]; then
  TRIAGE_ERRORS_JSON="$(printf '%s\n' "${TRIAGE_ERRORS[@]}" | jq -R . | jq -s .)"
else
  TRIAGE_ERRORS_JSON="[]"
fi
echo "triage.sh completed for session $SESSION_ID (ready=$READY_FOR_DISPATCH, errors=${#TRIAGE_ERRORS[@]})" >&2
jq -n \
  --arg sid "$SESSION_ID" \
  --arg priority "$PRIORITY" \
  --arg effort "$EFFORT" \
  --arg target "$TARGET_QUEUE_LABEL" \
  --arg project_slug "$PROJECT_SLUG" \
  --arg project_channel_id "$PROJECT_CHANNEL_ID" \
  --arg labels "$ALL_LABELS" \
  --argjson ready "$([[ "$READY_FOR_DISPATCH" == "true" ]] && echo "true" || echo "false")" \
  --argjson errors "$TRIAGE_ERRORS_JSON" \
  --argjson num "$ISSUE_NUMBER" \
  '{
    session_id: $sid,
    step: "triage",
    triage: {
      priority: $priority,
      effort: $effort,
      target_state: $target,
      project_slug: (if $project_slug != "" then $project_slug else null end),
      project_channel_id: (if $project_channel_id != "" then $project_channel_id else null end),
      labels_applied: ($labels | split(",")),
      issue_number: $num,
      ready_for_dispatch: $ready,
      errors: $errors
    }
  }'

genesis_metric_end "ok"
