#!/usr/bin/env bash
set -euo pipefail

# Step 2: Classify idea type
# Input: stdin JSON (from receive-idea.sh)
# Output: JSON with classification to stdout

GENESIS_LOG="${GENESIS_LOG:-$HOME/.openclaw/workspace/logs/genesis.log}"
mkdir -p "$(dirname "$GENESIS_LOG")"
exec 2> >(tee -a "$GENESIS_LOG" >&2)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RULES="$SCRIPT_DIR/../configs/classification-rules.json"
source "$SCRIPT_DIR/delivery-target-lib.sh"

score_gt_zero() {
  local value="${1:-0}"
  [[ "$(echo "$value > 0" | bc 2>/dev/null || echo 0)" == "1" ]]
}

INPUT="$(cat)"
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id')"
echo "=== $(date -Iseconds) | classify-idea.sh | session=$SESSION_ID ===" >&2
RAW_IDEA="$(echo "$INPUT" | jq -r '.raw_idea')"
METADATA="$(echo "$INPUT" | jq '.metadata // {}')"
THRESHOLD="$(jq -r '.confidence_threshold' "$RULES")"
DEFAULT_TYPE="$(jq -r '.default_type' "$RULES")"

echo "Classifying idea for session $SESSION_ID..." >&2

# === Try LLM-based classification first (via openclaw agent --local) ===
LLM_CLASSIFICATION=""
if command -v openclaw &>/dev/null; then
  echo "Trying LLM-based classification..." >&2
  VALID_TYPES="$(jq -r '.types | keys | join(", ")' "$RULES")"
  LLM_PROMPT="Classify this software project idea into exactly one type.

Valid types: $VALID_TYPES

Idea: $RAW_IDEA

Return ONLY valid JSON (no markdown fences, no explanation):
{\"type\": \"<one of: $VALID_TYPES>\", \"confidence\": <0.0-1.0>, \"reasoning\": \"<1 sentence>\"}"

  LLM_RAW="$(timeout 60 openclaw agent --local \
    -m "$LLM_PROMPT" \
    --session-id "genesis-classify-${SESSION_ID}" \
    --json 2>&1)" || echo "[classify-idea] LLM call failed (exit $?)" >&2

  if [[ -n "$LLM_RAW" ]]; then
    LLM_TEXT="$(echo "$LLM_RAW" | jq -r '.payloads[0].text // empty' 2>/dev/null || true)"
    LLM_TEXT="$(echo "$LLM_TEXT" | sed '/^```/d; /^json$/d')"
    # Validate: must have type field with a known type
    LLM_TYPE="$(echo "$LLM_TEXT" | jq -r '.type // empty' 2>/dev/null || true)"
    if [[ -n "$LLM_TYPE" ]] && jq -e --arg t "$LLM_TYPE" '.types[$t]' "$RULES" &>/dev/null; then
      LLM_CLASSIFICATION="$LLM_TEXT"
      echo "LLM classification: $LLM_TYPE" >&2
    fi
  fi
fi

# === LLM classification succeeded ===
if [[ -n "$LLM_CLASSIFICATION" ]]; then
  best_type="$(echo "$LLM_CLASSIFICATION" | jq -r '.type')"
  confidence="$(echo "$LLM_CLASSIFICATION" | jq -r '.confidence // 0.85')"
  reasoning="$(echo "$LLM_CLASSIFICATION" | jq -r '.reasoning // "LLM-based classification"')"
  reasoning="[LLM] $reasoning"
  alternatives="[]"
else
  # === Fallback: keyword/pattern matching ===
  echo "LLM unavailable, using keyword-based classification..." >&2

  IDEA_LOWER="$(echo "$RAW_IDEA" | tr '[:upper:]' '[:lower:]')"

  best_type="$DEFAULT_TYPE"
  best_score=0
  results="[]"

  for type in $(jq -r '.types | keys[]' "$RULES"); do
    score=0
    weight="$(jq -r ".types.\"$type\".weight" "$RULES")"

    # Keyword matching
    while IFS= read -r kw; do
      if [[ "$IDEA_LOWER" == *"$kw"* ]]; then
        score=$((score + 1))
      fi
    done < <(jq -r ".types.\"$type\".keywords[]" "$RULES")

    # Pattern matching
    while IFS= read -r pat; do
      if echo "$RAW_IDEA" | grep -qP "$pat" 2>/dev/null; then
        score=$((score + 2))
      fi
    done < <(jq -r ".types.\"$type\".patterns[]" "$RULES")

    # Apply weight
    weighted="$(echo "$score * $weight" | bc 2>/dev/null || echo "$score")"

    results="$(echo "$results" | jq --arg t "$type" --argjson s "$score" '. + [{"type": $t, "raw_score": $s}]')"

    if [[ "$(echo "$weighted > $best_score" | bc 2>/dev/null || echo 0)" == "1" ]] || \
       { [[ "$score" -gt 0 ]] && [[ "$best_score" == "0" ]]; }; then
      best_score="$weighted"
      best_type="$type"
    fi
  done

  # Calculate confidence
  if score_gt_zero "$best_score"; then
    confidence="$(echo "scale=2; $best_score / ($best_score + 2)" | bc 2>/dev/null || echo "0.50")"
  else
    confidence="0.30"
  fi

  # Build alternatives
  alternatives="$(echo "$results" | jq --arg best "$best_type" '[.[] | select(.type != $best and .raw_score > 0) | {type: .type, confidence: ((.raw_score / (.raw_score + 3)) * 100 | floor / 100)}]')"

  if score_gt_zero "$best_score"; then
    reasoning="[Keywords] Classified as '$best_type' based on $best_score keyword/pattern matches."
  else
    reasoning="[Keywords] No strong signals found. Defaulting to '$DEFAULT_TYPE'."
  fi
fi

DELIVERY_TARGET_RAW="$(echo "$INPUT" | jq -r '.metadata.delivery_target // empty')"
if [[ -z "$DELIVERY_TARGET_RAW" || "$DELIVERY_TARGET_RAW" == "null" ]]; then
  DELIVERY_TARGET="$(genesis_detect_delivery_target_from_text "$RAW_IDEA")"
else
  DELIVERY_TARGET="$(genesis_normalize_delivery_target "$DELIVERY_TARGET_RAW")"
fi

echo "Result: $best_type (confidence: $confidence)" >&2
echo "Delivery target: $DELIVERY_TARGET" >&2

jq -n \
  --arg sid "$SESSION_ID" \
  --arg idea "$RAW_IDEA" \
  --arg type "$best_type" \
  --argjson conf "$confidence" \
  --argjson alts "$alternatives" \
  --arg reasoning "$reasoning" \
  --arg delivery_target "$DELIVERY_TARGET" \
  --argjson meta "$METADATA" \
  '{
    session_id: $sid,
    step: "classify",
    raw_idea: $idea,
    classification: {
      type: $type,
      confidence: $conf,
      alternatives: $alts,
      reasoning: $reasoning,
      delivery_target: $delivery_target
    },
    metadata: $meta
  }'
