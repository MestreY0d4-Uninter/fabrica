#!/usr/bin/env bash
set -euo pipefail

# Validate critical Genesis step envelopes with deterministic jq checks.
# Usage: validate-step.sh <classify|spec|impact>
# Input: JSON on stdin
# Output: same JSON on stdout (if valid)

STEP="${1:-}"
if [[ -n "${1:-}" && -f "${1:-}" ]]; then
  INPUT="$(cat "$1")"
else
  INPUT="$(cat)"
fi

fail() {
  local reason="${1:-validation_failed}"
  echo "ERROR: [$STEP] $reason" >&2
  exit 1
}

require_json() {
  echo "$INPUT" | jq -e . >/dev/null 2>&1 || fail "invalid_json"
}

validate_classify() {
  echo "$INPUT" | jq -e '
    (.session_id | type == "string" and length > 0) and
    (.step == "classify") and
    (.raw_idea | type == "string" and length > 0) and
    (.classification | type == "object") and
    (.classification.type | IN("feature","bugfix","refactor","research","infra")) and
    (.classification.confidence | type == "number" and . >= 0 and . <= 1) and
    (.classification.reasoning | type == "string" and length > 0) and
    ((.classification.delivery_target // "unknown") | IN("web-ui","api","cli","hybrid","unknown"))
  ' >/dev/null 2>&1 || fail "schema_violation"
}

validate_spec() {
  echo "$INPUT" | jq -e '
    (.session_id | type == "string" and length > 0) and
    (.step == "spec") and
    (.spec | type == "object") and
    (.spec.title | type == "string" and length > 0) and
    (.spec.type | IN("feature","bugfix","refactor","research","infra")) and
    (.spec.objective | type == "string" and length >= 10) and
    (.spec.scope_v1 | type == "array" and length >= 1) and
    (.spec.out_of_scope | type == "array") and
    (.spec.acceptance_criteria | type == "array" and length >= 1) and
    (.spec.definition_of_done | type == "array" and length >= 1) and
    (.spec.constraints | type == "string") and
    ((.spec.delivery_target // "unknown") | IN("web-ui","api","cli","hybrid","unknown"))
  ' >/dev/null 2>&1 || fail "schema_violation"
}

validate_impact() {
  echo "$INPUT" | jq -e '
    (.session_id | type == "string" and length > 0) and
    (.step == "impact") and
    (.impact | type == "object") and
    (.impact.affected_files | type == "array") and
    (.impact.new_files_needed | type == "array") and
    (.impact.affected_modules | type == "array") and
    (.impact.risk_areas | type == "array") and
    (.impact.estimated_files_changed | type == "number" and . >= 0 and (floor == .)) and
    (.impact.is_greenfield | type == "boolean")
  ' >/dev/null 2>&1 || fail "schema_violation"
}

require_json

case "$STEP" in
  classify) validate_classify ;;
  spec) validate_spec ;;
  impact) validate_impact ;;
  *)
    fail "unknown_step"
    ;;
esac

echo "$INPUT"
