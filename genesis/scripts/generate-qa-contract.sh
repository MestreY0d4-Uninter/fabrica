#!/usr/bin/env bash
set -euo pipefail

# Step 7: Generate QA contract (qa.sh) from spec
# Input: stdin JSON (with spec.acceptance_criteria)
# Output: JSON with qa_contract to stdout

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/stack-detection-lib.sh"
source "$SCRIPT_DIR/genesis-telemetry.sh"

if [[ -n "${1:-}" && -f "${1:-}" ]]; then
  INPUT="$(cat "$1")"
else
  INPUT="$(cat)"
fi
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id')"
SPEC="$(echo "$INPUT" | jq '.spec // {}')"
TYPE="$(echo "$INPUT" | jq -r '.classification.type // "feature"')"
METADATA="$(echo "$INPUT" | jq '.metadata // {}')"
CLASSIFICATION="$(echo "$INPUT" | jq '.classification // {}')"
INTERVIEW="$(echo "$INPUT" | jq '.interview // {}')"
IMPACT="$(echo "$INPUT" | jq '.impact // {}')"
PROJECT_MAP="$(echo "$INPUT" | jq '.project_map // {}')"
SCAFFOLD="$(echo "$INPUT" | jq '.scaffold // {}')"
STACK_HINT="$(echo "$SCAFFOLD" | jq -r '.stack // ""' | tr '[:upper:]' '[:lower:]')"

genesis_metric_start "generate-qa-contract" "$SESSION_ID"
echo "Generating QA contract for session $SESSION_ID..." >&2

# Detect stack flags using shared stack-detection-lib.sh
LANGUAGES="$(echo "$PROJECT_MAP" | jq -r '.stats.languages // [] | .[]' 2>/dev/null || echo "")"
SCOPE_TEXT="$(echo "$SPEC" | jq -r '(.scope_v1 // []) | join(" ")' | tr '[:upper:]' '[:lower:]')"

read -r IS_PY IS_JS IS_GO <<< "$(genesis_detect_stack_flags_from_context "$STACK_HINT" "$LANGUAGES" "$SCOPE_TEXT")"

if ! $IS_PY && ! $IS_JS && ! $IS_GO; then
  echo "No stack detected — qa.sh will fail closed until stack is explicit" >&2
fi

echo "Stack detected: PY=$IS_PY JS=$IS_JS GO=$IS_GO" >&2

# Build acceptance criteria comments for qa.sh
AC_COMMENTS=""
AC_INDEX=0
while IFS= read -r ac; do
  [[ -z "$ac" ]] && continue
  AC_INDEX=$((AC_INDEX + 1))
  AC_COMMENTS="$AC_COMMENTS
# AC$AC_INDEX: $ac"
done < <(echo "$SPEC" | jq -r '.acceptance_criteria // [] | .[]')

# Generate qa.sh script content
QA_SCRIPT='#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
QA_VENV="${QA_VENV:-$HOME/.openclaw/qa-venv}"
[ -d "$QA_VENV/bin" ] && export PATH="$QA_VENV/bin:$PATH"
PASS=0; FAIL=0
gate() { local n="$1"; shift; printf "==> %s\n" "$n"; if "$@"; then PASS=$((PASS+1)); printf "    PASS\n"; else FAIL=$((FAIL+1)); printf "    FAIL\n"; return 1; fi; }

# SECURITY: This script output may be embedded in PR descriptions.
# It must NEVER print environment variables, tokens, API keys, or host paths.

# === Acceptance Criteria ==='"$AC_COMMENTS"'

# === Stack Detection ==='

QA_SCRIPT="$QA_SCRIPT"'
if ! '"$IS_PY"' && ! '"$IS_JS"' && ! '"$IS_GO"'; then
  echo "UNKNOWN STACK: unable to infer stack from scaffold/project map/spec."
  echo "Update scaffold.stack or project_map.stats.languages and regenerate QA contract."
  exit 1
fi'

if $IS_PY; then
  QA_SCRIPT="$QA_SCRIPT"'
IS_PY=true
$IS_PY && command -v ruff >/dev/null && gate "Lint (Python)" ruff check . || true
$IS_PY && command -v mypy >/dev/null && gate "Types (Python)" mypy . --ignore-missing-imports || true'
fi

if $IS_JS; then
  QA_SCRIPT="$QA_SCRIPT"'
IS_JS=true
$IS_JS && [ -f node_modules/.bin/eslint ] && gate "Lint (JS/TS)" npx eslint . || true
$IS_JS && [ -f tsconfig.json ] && gate "Types (TS)" npx tsc --noEmit || true'
fi

if $IS_GO; then
  QA_SCRIPT="$QA_SCRIPT"'
IS_GO=true
$IS_GO && gate "Lint (Go)" go vet ./... || true'
fi

QA_SCRIPT="$QA_SCRIPT"'

# === Security Gate ===
command -v openclaw >/dev/null && gate "Security (ClawScan)" openclaw invoke --skill clawscan --tool scan-local --args-json '"'"'{"path":"."}'"'"' || true

# === Test Gate ==='

if $IS_PY; then
  QA_SCRIPT="$QA_SCRIPT"'
$IS_PY && gate "Tests (Python)" python -m pytest -v --tb=short || true'
fi

if $IS_JS; then
  QA_SCRIPT="$QA_SCRIPT"'
$IS_JS && gate "Tests (JS)" npm test || true'
fi

if $IS_GO; then
  QA_SCRIPT="$QA_SCRIPT"'
$IS_GO && gate "Tests (Go)" go test -v ./... || true'
fi

QA_SCRIPT="$QA_SCRIPT"'

# === Coverage Gate (>= 80%) ===
'

if $IS_PY; then
  QA_SCRIPT="$QA_SCRIPT"'
$IS_PY && gate "Coverage (Python >=80%)" python -m pytest -q --cov=. --cov-report=term-missing --cov-fail-under=80 || true'
fi

if $IS_JS; then
  QA_SCRIPT="$QA_SCRIPT"'
$IS_JS && gate "Coverage (JS/TS >=80%)" npx vitest run --coverage --coverage.thresholds.lines=80 || true'
fi

if $IS_GO; then
  QA_SCRIPT="$QA_SCRIPT"'
$IS_GO && gate "Coverage (Go >=80%)" bash -lc '\''go test -coverprofile=coverage.out ./... && go tool cover -func=coverage.out | awk "/^total:/ {gsub(/%/,\"\",\\$3); exit !(\\$3>=80)}"'\'' || true'
fi

QA_SCRIPT="$QA_SCRIPT"'

TOTAL=$((PASS+FAIL))
if [[ "$TOTAL" -eq 0 ]]; then
  echo "NO QA GATES EXECUTED"
  exit 1
fi
echo "QA: $PASS/$TOTAL passed"
[ "$FAIL" -gt 0 ] && echo "FAILED" && exit 1
echo "ALL QA GATES PASSED"'

# Build gates list
GATES='["lint", "types", "security", "tests", "coverage"]'

# Build acceptance tests from ACs
ACCEPTANCE_TESTS="$(echo "$SPEC" | jq '[.acceptance_criteria // [] | .[] | {criterion: ., gate: "tests", automated: false}]')"

echo "QA contract generated: $AC_INDEX acceptance criteria, gates=$(echo "$GATES" | jq 'length')" >&2

jq -n \
  --arg sid "$SESSION_ID" \
  --arg script "$QA_SCRIPT" \
  --argjson gates "$GATES" \
  --argjson tests "$ACCEPTANCE_TESTS" \
  --argjson spec "$SPEC" \
  --argjson cls "$CLASSIFICATION" \
  --argjson interview "$INTERVIEW" \
  --argjson impact "$IMPACT" \
  --argjson map "$PROJECT_MAP" \
  --argjson scaffold "$SCAFFOLD" \
  --argjson meta "$METADATA" \
  '{
    session_id: $sid,
    step: "qa",
    qa_contract: {
      script_content: $script,
      gates: $gates,
      coverage_threshold: 80,
      acceptance_tests: $tests
    },
    spec: $spec,
    classification: $cls,
    interview: $interview,
    impact: $impact,
    project_map: $map,
    scaffold: $scaffold,
    metadata: $meta
  }'

genesis_metric_end "ok"
