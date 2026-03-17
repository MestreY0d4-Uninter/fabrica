#!/usr/bin/env bash
set -euo pipefail

# Step 4: Generate structured specification from classification + interview answers
# Input: stdin JSON (classification + interview with answers)
# Output: JSON with full spec to stdout
# Note: The LLM fills answers via llm-task. This script structures them into
#       the mandatory headings required by issue_checklist.py:
#       Objetivo, Escopo V1, Fora de escopo, Acceptance Criteria, DoD, Restrições

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/delivery-target-lib.sh"

INPUT="$(cat)"
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id')"
RAW_IDEA="$(echo "$INPUT" | jq -r '.raw_idea')"
TYPE="$(echo "$INPUT" | jq -r '.classification.type')"
CLASSIFICATION="$(echo "$INPUT" | jq '.classification')"
INTERVIEW="$(echo "$INPUT" | jq '.interview // {}')"
METADATA="$(echo "$INPUT" | jq '.metadata // {}')"

echo "Generating specification for session $SESSION_ID (type=$TYPE)..." >&2

# Extract structured data from the LLM interview output
# The llm-task step should return a JSON with these fields
TITLE="$(echo "$INPUT" | jq -r '.spec_data.title // .interview.spec_data.title // .raw_idea' | cut -c1-120)"
OBJECTIVE="$(echo "$INPUT" | jq -r '.spec_data.objective // .interview.spec_data.objective // "See raw idea"')"
SCOPE="$(echo "$INPUT" | jq '.spec_data.scope_v1 // .interview.spec_data.scope_v1 // [.raw_idea]')"
OUT_OF_SCOPE="$(echo "$INPUT" | jq '.spec_data.out_of_scope // .interview.spec_data.out_of_scope // ["To be defined during implementation"]')"
ACS="$(echo "$INPUT" | jq '.spec_data.acceptance_criteria // .interview.spec_data.acceptance_criteria // ["Feature works as described in the objective"]')"
DOD="$(echo "$INPUT" | jq '.spec_data.definition_of_done // .interview.spec_data.definition_of_done // ["Code reviewed and merged", "Tests pass", "QA contract passes"]')"
CONSTRAINTS="$(echo "$INPUT" | jq -r '.spec_data.constraints // .interview.spec_data.constraints // "None specified"')"
RISKS="$(echo "$INPUT" | jq '.spec_data.risks // .interview.spec_data.risks // []')"
DELIVERY_TARGET_RAW="$(echo "$INPUT" | jq -r '.spec_data.delivery_target // .interview.spec_data.delivery_target // .classification.delivery_target // .metadata.delivery_target // empty')"
if [[ -z "$DELIVERY_TARGET_RAW" || "$DELIVERY_TARGET_RAW" == "null" ]]; then
  DELIVERY_TARGET="$(genesis_detect_delivery_target_from_text "$RAW_IDEA")"
else
  DELIVERY_TARGET_NORMALIZED="$(genesis_normalize_delivery_target "$DELIVERY_TARGET_RAW")"
  DELIVERY_TARGET="$(genesis_cross_validate_delivery_target "$DELIVERY_TARGET_NORMALIZED" "$RAW_IDEA")"
fi

# Validate minimum requirements
scope_count="$(echo "$SCOPE" | jq 'length')"
ac_count="$(echo "$ACS" | jq 'length')"
dod_count="$(echo "$DOD" | jq 'length')"

if [[ "$scope_count" -lt 1 ]]; then
  echo "WARNING: Empty scope — using raw idea as scope item" >&2
  SCOPE="$(jq -n --arg i "$RAW_IDEA" '[$i]')"
fi

if [[ "$ac_count" -lt 1 ]]; then
  echo "WARNING: No acceptance criteria — adding default" >&2
  ACS='["Feature works as described in the objective"]'
fi

if [[ "$dod_count" -lt 1 ]]; then
  echo "WARNING: No definition of done — adding defaults" >&2
  DOD='["Code reviewed and merged", "Tests pass", "QA contract passes"]'
fi

ACS_JOINED_LOWER="$(echo "$ACS" | jq -r 'join(" ")' | tr '[:upper:]' '[:lower:]')"
append_ac() {
  local item="$1"
  ACS="$(echo "$ACS" | jq --arg i "$item" '. + [$i]')"
}
append_dod() {
  local item="$1"
  DOD="$(echo "$DOD" | jq --arg i "$item" '. + [$i]')"
}

case "$DELIVERY_TARGET" in
  web-ui)
    if ! echo "$ACS_JOINED_LOWER" | grep -Eqi '\b(tela|página|pagina|ui|interface|dashboard|fluxo)\b'; then
      append_ac "Existe ao menos uma tela funcional do fluxo principal, navegavel de ponta a ponta."
    fi
    ;;
  api)
    if ! echo "$ACS_JOINED_LOWER" | grep -Eqi '\b(api|endpoint|rota|route|http|rest)\b'; then
      append_ac "Existe ao menos um endpoint/API funcional do fluxo principal, com resposta valida."
    fi
    ;;
  cli)
    if ! echo "$ACS_JOINED_LOWER" | grep -Eqi '\b(cli|terminal|comando|linha de comando|console)\b'; then
      append_ac "Existe ao menos um comando CLI funcional do fluxo principal."
    fi
    ;;
  hybrid)
    if ! echo "$ACS_JOINED_LOWER" | grep -Eqi '\b(tela|página|pagina|ui|interface|dashboard|fluxo)\b'; then
      append_ac "Existe ao menos uma interface/tela funcional para o fluxo principal."
    fi
    if ! echo "$ACS_JOINED_LOWER" | grep -Eqi '\b(api|endpoint|rota|route|http|rest)\b'; then
      append_ac "Existe ao menos uma API/endpoint funcional para suportar o fluxo principal."
    fi
    ;;
esac

# Auth requirements gate (hybrid policy):
# - If idea indicates auth/per-profile needs and spec has no auth evidence,
#   auto-append minimal AC/DoD to prevent contract drift.
AUTH_REGEX='\b(login|autentic|senha|perfil|permiss|acesso|rbac|admin)\b'
AUTH_SIGNAL=false
AUTH_EVIDENCE=false
AUTH_SIGNAL_TEXT="$(printf '%s %s' "$RAW_IDEA" "$OBJECTIVE" | tr '[:upper:]' '[:lower:]')"
AUTH_EVIDENCE_TEXT="$(printf '%s %s %s' "$OBJECTIVE" "$(echo "$SCOPE" | jq -r 'join(" ")')" "$(echo "$ACS" | jq -r 'join(" ")')" | tr '[:upper:]' '[:lower:]')"

if echo "$AUTH_SIGNAL_TEXT" | grep -Eqi "$AUTH_REGEX"; then
  AUTH_SIGNAL=true
fi
if echo "$AUTH_EVIDENCE_TEXT" | grep -Eqi "$AUTH_REGEX"; then
  AUTH_EVIDENCE=true
fi
if [[ "$AUTH_SIGNAL" == "true" && "$AUTH_EVIDENCE" != "true" ]]; then
  append_ac "Usuarios autenticados conseguem iniciar sessao com credenciais validas."
  append_ac "Acoes criticas exigem autorizacao por perfil (ex.: admin/operador/leitura)."
  append_dod "Existe teste cobrindo autorizacao por perfil em ao menos um fluxo critico."
  AUTH_EVIDENCE=true
fi

CONSTRAINTS_BASE="$CONSTRAINTS"
if [[ -n "$CONSTRAINTS_BASE" && "$CONSTRAINTS_BASE" != "None specified" ]]; then
  CONSTRAINTS="$CONSTRAINTS_BASE Delivery target: $DELIVERY_TARGET."
else
  CONSTRAINTS="Delivery target: $DELIVERY_TARGET."
fi
ac_count="$(echo "$ACS" | jq 'length')"
dod_count="$(echo "$DOD" | jq 'length')"
META_ENRICHED="$(echo "$METADATA" | jq --argjson signal "$AUTH_SIGNAL" --argjson evidence "$AUTH_EVIDENCE" '. + {auth_gate: {signal: $signal, evidence: $evidence}}')"

echo "Spec: title='$TITLE', scope=$scope_count items, ACs=$ac_count, DoD=$dod_count" >&2

jq -n \
  --arg sid "$SESSION_ID" \
  --arg raw_idea "$RAW_IDEA" \
  --arg title "$TITLE" \
  --arg type "$TYPE" \
  --arg objective "$OBJECTIVE" \
  --argjson scope "$SCOPE" \
  --argjson oos "$OUT_OF_SCOPE" \
  --argjson acs "$ACS" \
  --argjson dod "$DOD" \
  --arg constraints "$CONSTRAINTS" \
  --argjson risks "$RISKS" \
  --arg delivery_target "$DELIVERY_TARGET" \
  --argjson cls "$CLASSIFICATION" \
  --argjson interview "$INTERVIEW" \
  --argjson meta "$META_ENRICHED" \
  '{
    session_id: $sid,
    step: "spec",
    raw_idea: $raw_idea,
    spec: {
      title: $title,
      type: $type,
      objective: $objective,
      scope_v1: $scope,
      out_of_scope: $oos,
      acceptance_criteria: $acs,
      definition_of_done: $dod,
      constraints: $constraints,
      risks: $risks,
      delivery_target: $delivery_target
    },
    classification: $cls,
    interview: $interview,
    metadata: $meta
  }'
