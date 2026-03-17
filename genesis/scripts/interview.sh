#!/usr/bin/env bash
set -euo pipefail

# Step 3: Generate adaptive interview questions
# Input: stdin JSON (from classify-idea.sh)
# Output: JSON with questions array and guidelines to stdout
# Note: This script GENERATES questions. The actual interview is conducted by
#       the LLM via llm-task in the Lobster workflow.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES="$SCRIPT_DIR/../configs/interview-templates.json"

INPUT="$(cat)"
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id')"
RAW_IDEA="$(echo "$INPUT" | jq -r '.raw_idea')"
TYPE="$(echo "$INPUT" | jq -r '.classification.type')"
CONFIDENCE="$(echo "$INPUT" | jq -r '.classification.confidence')"
METADATA="$(echo "$INPUT" | jq '.metadata // {}')"
CLASSIFICATION="$(echo "$INPUT" | jq '.classification')"

echo "Generating interview questions for type=$TYPE (confidence=$CONFIDENCE)..." >&2

# Get round1 questions for this type
ROUND1="$(jq --arg t "$TYPE" '.types[$t].round1 // []' "$TEMPLATES")"

# Determine detail level from the idea text length and specificity
IDEA_LENGTH="${#RAW_IDEA}"
if [[ "$IDEA_LENGTH" -lt 30 ]]; then
  DETAIL_LEVEL="low"
  echo "Short idea detected — will include follow-ups and non-technical questions" >&2
elif [[ "$IDEA_LENGTH" -lt 100 ]]; then
  DETAIL_LEVEL="medium"
  echo "Medium detail — standard question set" >&2
else
  DETAIL_LEVEL="high"
  echo "Detailed idea — will include technical additions" >&2
fi

# Build question set based on detail level
# Deterministic baseline: start from required questions only.
QUESTIONS="$(echo "$ROUND1" | jq '[.[] | select(.required == true)]')"

# Detect explicit technical intent instead of relying only on text length.
if echo "$RAW_IDEA" | grep -Eqi '(api|endpoint|sdk|lat[eê]ncia|throughput|schema|tabela|cole[cç][aã]o|banco|deploy|infra|stack|servi[cç]o externo|integra[cç][aã]o)'; then
  TECH_SIGNAL="true"
else
  TECH_SIGNAL="false"
fi

if [[ "$DETAIL_LEVEL" == "high" ]]; then
  # Add technical additions only when the user idea carries technical signals.
  if [[ "$TECH_SIGNAL" == "true" ]]; then
    TECH="$(jq --arg t "$TYPE" '.types[$t].technical_additions // [] | .[:1]' "$TEMPLATES")"
    QUESTIONS="$(echo "$QUESTIONS" | jq --argjson tech "$TECH" '. + $tech')"
  fi
elif [[ "$DETAIL_LEVEL" == "low" ]]; then
  # Vague idea: add at most one non-technical clarifier.
  NON_TECH="$(jq --arg t "$TYPE" '.types[$t].non_technical_additions // [] | .[:1]' "$TEMPLATES")"
  QUESTIONS="$(echo "$QUESTIONS" | jq --argjson nt "$NON_TECH" '. + $nt')"
fi

# Hard cap to avoid long interviews in chat channels.
QUESTIONS="$(echo "$QUESTIONS" | jq '.[0:4]')"

# If confidence is low, add questions about alternative types
ALT_NOTE=""
if [[ "$(echo "$CONFIDENCE < 0.6" | bc 2>/dev/null || echo 0)" == "1" ]]; then
  ALT_NOTE="Low confidence in classification ($CONFIDENCE). Ask the user to confirm the type: is this a $TYPE, or something else?"
fi

# Guidelines for the LLM conducting the interview
GUIDELINES="Follow SOUL.md tone. Ask only the provided questions in order. Keep language non-technical by default and only go technical if the user introduces technical constraints. Maximum 2 interview rounds. If an answer is vague and has follow_up_if_vague, use one concise follow-up. ${ALT_NOTE}"

jq -n \
  --arg sid "$SESSION_ID" \
  --arg idea "$RAW_IDEA" \
  --argjson cls "$CLASSIFICATION" \
  --argjson questions "$QUESTIONS" \
  --arg guidelines "$GUIDELINES" \
  --arg detail "$DETAIL_LEVEL" \
  --argjson meta "$METADATA" \
  '{
    session_id: $sid,
    step: "interview",
    raw_idea: $idea,
    classification: $cls,
    interview: {
      round: 1,
      questions: $questions,
      detail_level: $detail,
      guidelines: $guidelines
    },
    metadata: $meta
  }'
