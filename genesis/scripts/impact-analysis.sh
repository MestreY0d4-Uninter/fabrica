#!/usr/bin/env bash
set -euo pipefail

# Step 6: Impact analysis — cross-reference spec against project map
# Input: stdin JSON (spec + project_map)
# Output: JSON with impact report to stdout

INPUT="$(cat)"
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id')"
IS_GREENFIELD="$(echo "$INPUT" | jq -r '.is_greenfield // false')"
SPEC="$(echo "$INPUT" | jq '.spec // {}')"
PROJECT_MAP="$(echo "$INPUT" | jq '.project_map // {}')"
METADATA="$(echo "$INPUT" | jq '.metadata // {}')"
CLASSIFICATION="$(echo "$INPUT" | jq '.classification // {}')"
INTERVIEW="$(echo "$INPUT" | jq '.interview // {}')"

echo "Running impact analysis for session $SESSION_ID..." >&2

# Greenfield — no existing code to analyze
if [[ "$IS_GREENFIELD" == "true" ]]; then
  echo "Greenfield project — estimating new files needed" >&2

  # Estimate new files from scope items
  SCOPE_COUNT="$(echo "$SPEC" | jq '.scope_v1 | length')"
  AC_COUNT="$(echo "$SPEC" | jq '.acceptance_criteria | length')"

  jq -n \
    --arg sid "$SESSION_ID" \
    --argjson spec "$SPEC" \
    --argjson map "$PROJECT_MAP" \
    --argjson cls "$CLASSIFICATION" \
    --argjson interview "$INTERVIEW" \
    --argjson meta "$METADATA" \
    --argjson sc "$SCOPE_COUNT" \
    --argjson ac "$AC_COUNT" \
    '{
      session_id: $sid,
      step: "impact",
      impact: {
        affected_files: [],
        new_files_needed: ["README.md", "package.json or pyproject.toml", "src/ (main source)", "tests/ (test suite)"],
        affected_modules: [],
        risk_areas: ["New project — no established patterns yet"],
        estimated_files_changed: ($sc * 2 + 4),
        is_greenfield: true
      },
      spec: $spec,
      project_map: $map,
      classification: $cls,
      interview: $interview,
      metadata: $meta
    }'
  exit 0
fi

echo "Cross-referencing spec keywords against project symbols..." >&2

# Extract keywords from spec for matching
SPEC_KEYWORDS="$(echo "$SPEC" | jq -r '
  [.title, .objective, (.scope_v1 // [] | .[]), (.acceptance_criteria // [] | .[])]
  | map(select(. != null and . != "") | ascii_downcase | split(" ") | .[] | select(length > 3))
  | unique | .[]
')"

# Get all symbols from project map
SYMBOLS="$(echo "$PROJECT_MAP" | jq '.symbols // []')"
FILES="$(echo "$PROJECT_MAP" | jq '[.symbols // [] | .[].file] | unique')"

# Match keywords against symbol names and file paths
AFFECTED_FILES="[]"
AFFECTED_MODULES="[]"
RISK_AREAS="[]"

while IFS= read -r keyword; do
  [[ -z "$keyword" ]] && continue

  # Match against symbol names
  MATCHES="$(echo "$SYMBOLS" | jq --arg kw "$keyword" '[.[] | select(.name | ascii_downcase | contains($kw)) | .file] | unique')"

  if [[ "$(echo "$MATCHES" | jq 'length')" -gt 0 ]]; then
    AFFECTED_FILES="$(echo "$AFFECTED_FILES" | jq --argjson m "$MATCHES" '. + $m | unique')"
  fi

  # Match against file paths
  FILE_MATCHES="$(echo "$FILES" | jq --arg kw "$keyword" '[.[] | select(ascii_downcase | contains($kw))]')"
  if [[ "$(echo "$FILE_MATCHES" | jq 'length')" -gt 0 ]]; then
    AFFECTED_FILES="$(echo "$AFFECTED_FILES" | jq --argjson m "$FILE_MATCHES" '. + $m | unique')"
  fi
done <<< "$SPEC_KEYWORDS"

# Extract modules (directories of affected files)
AFFECTED_MODULES="$(echo "$AFFECTED_FILES" | jq '[.[] | split("/") | if length > 1 then .[0:-1] | join("/") else "root" end] | unique')"

# Risk areas from spec
RISK_AREAS="$(echo "$SPEC" | jq '.risks // []')"

# Estimate total files changed
AFFECTED_COUNT="$(echo "$AFFECTED_FILES" | jq 'length')"
SCOPE_COUNT="$(echo "$SPEC" | jq '.scope_v1 | length')"
ESTIMATED="$((AFFECTED_COUNT > SCOPE_COUNT ? AFFECTED_COUNT : SCOPE_COUNT))"

echo "Impact: $AFFECTED_COUNT files matched, $ESTIMATED estimated total" >&2

jq -n \
  --arg sid "$SESSION_ID" \
  --argjson affected "$AFFECTED_FILES" \
  --argjson modules "$AFFECTED_MODULES" \
  --argjson risks "$RISK_AREAS" \
  --argjson est "$ESTIMATED" \
  --argjson spec "$SPEC" \
  --argjson map "$PROJECT_MAP" \
  --argjson cls "$CLASSIFICATION" \
  --argjson interview "$INTERVIEW" \
  --argjson meta "$METADATA" \
  '{
    session_id: $sid,
    step: "impact",
    impact: {
      affected_files: $affected,
      new_files_needed: [],
      affected_modules: $modules,
      risk_areas: $risks,
      estimated_files_changed: $est,
      is_greenfield: false
    },
    spec: $spec,
    project_map: $map,
    classification: $cls,
    interview: $interview,
    metadata: $meta
  }'
