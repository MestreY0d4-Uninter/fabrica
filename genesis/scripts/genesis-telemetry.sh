#!/usr/bin/env bash
# genesis-telemetry.sh — Structured telemetry for Genesis pipeline steps
# Emits JSON metrics to a log file for observability.
# shellcheck shell=bash

if [ -z "${BASH_VERSION:-}" ]; then
  echo "ERROR: genesis-telemetry.sh requires bash." >&2
  return 1 2>/dev/null || exit 1
fi

[[ -n "${_GENESIS_TELEMETRY_LOADED:-}" ]] && return 0
_GENESIS_TELEMETRY_LOADED=1

GENESIS_METRICS_FILE="${GENESIS_METRICS_FILE:-$HOME/.openclaw/workspace/logs/genesis-metrics.jsonl}"
mkdir -p "$(dirname "$GENESIS_METRICS_FILE")" 2>/dev/null || true

# _genesis_epoch_ms — current time in milliseconds
_genesis_epoch_ms() {
  if date +%s%3N >/dev/null 2>&1; then
    date +%s%3N
  else
    echo "$(date +%s)000"
  fi
}

# genesis_metric_start <step_name> <session_id>
# Call at the beginning of a pipeline step. Stores start time in env.
# Returns: nothing (sets _GENESIS_METRIC_START_MS)
genesis_metric_start() {
  local step="${1:-unknown}"
  local session_id="${2:-}"
  export _GENESIS_METRIC_STEP="$step"
  export _GENESIS_METRIC_SESSION="$session_id"
  export _GENESIS_METRIC_START_MS="$(_genesis_epoch_ms)"
}

# genesis_metric_end <status> [error_message]
# Call at the end of a pipeline step. Emits JSON metric line.
# status: "ok", "error", "skipped"
genesis_metric_end() {
  local status="${1:-ok}"
  local error_msg="${2:-}"
  local end_ms duration_ms

  end_ms="$(_genesis_epoch_ms)"
  if [[ -n "${_GENESIS_METRIC_START_MS:-}" ]]; then
    duration_ms=$(( end_ms - _GENESIS_METRIC_START_MS ))
  else
    duration_ms=0
  fi

  jq -n -c \
    --arg step "${_GENESIS_METRIC_STEP:-unknown}" \
    --arg session_id "${_GENESIS_METRIC_SESSION:-}" \
    --arg status "$status" \
    --argjson duration_ms "$duration_ms" \
    --arg error "$error_msg" \
    --arg timestamp "$(date -Iseconds)" \
    '{
      step: $step,
      session_id: $session_id,
      status: $status,
      duration_ms: $duration_ms,
      timestamp: $timestamp
    }
    + (if $error != "" then {error: $error} else {} end)
    ' >> "$GENESIS_METRICS_FILE" 2>/dev/null || true

  unset _GENESIS_METRIC_STEP _GENESIS_METRIC_SESSION _GENESIS_METRIC_START_MS
}

# genesis_emit_metric <step> <session_id> <status> <duration_ms> [error]
# Direct metric emission (for scripts that don't use start/end pattern).
genesis_emit_metric() {
  local step="${1:-unknown}"
  local session_id="${2:-}"
  local status="${3:-ok}"
  local duration_ms="${4:-0}"
  local error_msg="${5:-}"

  jq -n -c \
    --arg step "$step" \
    --arg session_id "$session_id" \
    --arg status "$status" \
    --argjson duration_ms "$duration_ms" \
    --arg error "$error_msg" \
    --arg timestamp "$(date -Iseconds)" \
    '{
      step: $step,
      session_id: $session_id,
      status: $status,
      duration_ms: $duration_ms,
      timestamp: $timestamp
    }
    + (if $error != "" then {error: $error} else {} end)
    ' >> "$GENESIS_METRICS_FILE" 2>/dev/null || true
}
