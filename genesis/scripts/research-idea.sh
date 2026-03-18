#!/usr/bin/env bash
set -euo pipefail

# Step 2b: Web research on idea using Gemini web_search
# Input: stdin JSON (from classify-idea.sh — contains raw_idea + classification)
# Output: JSON with research findings added to stdout
# Graceful degradation: if web_search fails, research={} and pipeline continues

GENESIS_LOG="${GENESIS_LOG:-$HOME/.openclaw/workspace/logs/genesis.log}"
mkdir -p "$(dirname "$GENESIS_LOG")"
exec 2> >(tee -a "$GENESIS_LOG" >&2)

if [[ -n "${1:-}" && -f "${1:-}" ]]; then
  INPUT="$(cat "$1")"
else
  INPUT="$(cat)"
fi
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id')"
echo "=== $(date -Iseconds) | research-idea.sh | session=$SESSION_ID ===" >&2

RAW_IDEA="$(echo "$INPUT" | jq -r '.raw_idea // .idea // ""')"
TYPE="$(echo "$INPUT" | jq -r '.classification.type // "feature"')"

echo >&2 "[research] session=$SESSION_ID type=$TYPE idea=$(echo "$RAW_IDEA" | cut -c1-80)..."

# Check if GEMINI_API_KEY is set (loaded by gateway from .env)
# If not, passthrough — no blocking
if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  echo >&2 "[research] GEMINI_API_KEY not set — skipping web research (passthrough)"
  echo "$INPUT" | jq '. + { step: "research", research: {} }'
  exit 0
fi

# Build research prompt for the agent
RESEARCH_PROMPT="You have access to the web_search tool. Use it to research this software project idea.

Idea: $RAW_IDEA
Type: $TYPE

1. Search for the main technologies/frameworks mentioned or implied
2. Search for best practices and architecture patterns for this type of project
3. Synthesize your findings

Return ONLY valid JSON (no markdown fences, no explanation):
{
  \"technologies\": [\"tech1 - brief description\", \"tech2 - brief description\"],
  \"best_practices\": [\"practice1\", \"practice2\"],
  \"architecture_patterns\": [\"pattern1\", \"pattern2\"],
  \"references\": [{\"title\": \"...\", \"url\": \"...\"}, {\"title\": \"...\", \"url\": \"...\"}]
}"

RESEARCH="{}"

if command -v openclaw &>/dev/null; then
  echo >&2 "[research] Calling web_search via openclaw agent --local..."
  LLM_RAW="$(timeout 90 openclaw agent --local \
    -m "$RESEARCH_PROMPT" \
    --session-id "genesis-research-${SESSION_ID}" \
    --json 2>/dev/null)" || {
    echo >&2 "[research] openclaw agent call failed (exit $?) — continuing with empty research"
    LLM_RAW=""
  }

  if [[ -n "$LLM_RAW" ]]; then
    LLM_TEXT="$(echo "$LLM_RAW" | jq -r '.payloads[0].text // empty' 2>/dev/null || true)"
    # Strip markdown fences if present
    LLM_TEXT="$(echo "$LLM_TEXT" | sed '/^```/d; /^json$/d')"

    if [[ -n "$LLM_TEXT" ]] && echo "$LLM_TEXT" | jq -e '.' &>/dev/null 2>&1; then
      RESEARCH="$LLM_TEXT"
      TECH_COUNT="$(echo "$RESEARCH" | jq '.technologies // [] | length')"
      REF_COUNT="$(echo "$RESEARCH" | jq '.references // [] | length')"
      echo >&2 "[research] Success: $TECH_COUNT technologies, $REF_COUNT references found"
    else
      echo >&2 "[research] LLM returned invalid JSON — continuing with empty research"
    fi
  fi
else
  echo >&2 "[research] openclaw not found — skipping web research"
fi

# Merge research into the pipeline envelope
echo "$INPUT" | jq --argjson research "$RESEARCH" \
  '. + { step: "research", research: $research }'
