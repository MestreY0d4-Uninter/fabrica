#!/usr/bin/env bash
# stack-detection-lib.sh — Unified stack detection for Genesis pipeline
# Single source of truth: scaffold-project.sh and generate-qa-contract.sh
# both import this instead of maintaining their own detection logic.
# shellcheck shell=bash

if [ -z "${BASH_VERSION:-}" ]; then
  echo "ERROR: stack-detection-lib.sh requires bash." >&2
  return 1 2>/dev/null || exit 1
fi

# genesis_detect_stack_from_hint <stack_hint>
# Maps a raw stack hint (from GENESIS_STACK, scaffold.stack, etc.) to a
# canonical stack name, or returns empty string if unknown.
# Canonical stacks: nextjs, node-cli, express, fastapi, flask, django, python-cli
genesis_normalize_stack_hint() {
  local hint="${1:-}"
  hint="$(echo "$hint" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  case "$hint" in
    nextjs|express|node-cli|fastapi|flask|django|python-cli)
      printf '%s\n' "$hint"
      ;;
    *)
      # Unknown or generic (e.g., "python") — caller should auto-detect
      ;;
  esac
}

# genesis_detect_stack_from_text <text>
# Keyword-based stack detection from spec/idea text.
# Returns canonical stack name or empty string.
genesis_detect_stack_from_text() {
  local text="${1:-}"
  [[ -n "$text" ]] || return 0

  if echo "$text" | grep -qiE '\bnext\.?js\b|nextjs|\bnext\s+app\b'; then
    echo "nextjs"
  elif echo "$text" | grep -qiE '\bexpress\b|\bnode\.?js.*api\b|\bexpress\.?js\b'; then
    echo "express"
  elif echo "$text" | grep -qiE '\bfastapi\b|\bfast.?api\b'; then
    echo "fastapi"
  elif echo "$text" | grep -qiE '\bflask\b'; then
    echo "flask"
  elif echo "$text" | grep -qiE '\bdjango\b'; then
    echo "django"
  elif echo "$text" | grep -qiE '\bnode\.?js\b.*\bcli\b|\bcli\b.*\bnode\.?js\b|\btypescript\b.*\bcli\b|\bcli\b.*\btypescript\b|\bcommander\b'; then
    echo "node-cli"
  elif echo "$text" | grep -qiE '\bpython\b.*\bcli\b|\bcli\b.*\bpython\b|\bclick\b|\bargparse\b|\btyper\b'; then
    echo "python-cli"
  elif echo "$text" | grep -qiE '\bpython\b'; then
    echo "fastapi"
  elif echo "$text" | grep -qiE '\breact\b|\btypescript\b|\bfrontend\b|\bdashboard\b'; then
    echo "nextjs"
  elif echo "$text" | grep -qiE '\bapi\b|\bbackend\b|\brest\b|\bendpoint\b'; then
    echo "fastapi"
  fi
}

# genesis_detect_stack_from_delivery_target <delivery_target>
# Fallback: infer stack from delivery target.
genesis_detect_stack_from_delivery_target() {
  local target="${1:-}"
  case "$target" in
    web-ui|hybrid) echo "nextjs" ;;
    api)           echo "fastapi" ;;
    cli)           echo "python-cli" ;;
    *)             echo "fastapi" ;;
  esac
}

# genesis_stack_flags <stack>
# Given a canonical stack name, outputs IS_PY IS_JS IS_GO (space-separated booleans).
# Usage: read IS_PY IS_JS IS_GO <<< "$(genesis_stack_flags "$STACK")"
genesis_stack_flags() {
  local stack="${1:-}"
  case "$stack" in
    fastapi|flask|django|python-cli|python)
      echo "true false false"
      ;;
    nextjs|express|node|node-cli|javascript|typescript)
      echo "false true false"
      ;;
    go|golang)
      echo "false false true"
      ;;
    *)
      echo "false false false"
      ;;
  esac
}

# genesis_detect_stack_flags_from_context <stack_hint> <languages_text> <scope_text>
# Comprehensive flag detection used by generate-qa-contract.sh.
# Sets IS_PY, IS_JS, IS_GO based on multiple signal sources.
# Outputs: IS_PY IS_JS IS_GO (space-separated)
genesis_detect_stack_flags_from_context() {
  local stack_hint="${1:-}"
  local languages="${2:-}"
  local scope_text="${3:-}"
  local IS_PY=false IS_JS=false IS_GO=false

  # Priority 1: explicit scaffold stack
  case "$stack_hint" in
    fastapi|flask|django|python|python-cli) IS_PY=true ;;
    nextjs|express|node|node-cli|javascript|typescript) IS_JS=true ;;
    go|golang) IS_GO=true ;;
  esac

  # Priority 2: language/scope signals (additive — a project can be multi-stack)
  if [[ "$languages" == *"python"* ]] || [[ "$scope_text" == *"python"* ]] || \
     [[ "$scope_text" == *"django"* ]] || [[ "$scope_text" == *"flask"* ]] || \
     [[ "$scope_text" == *"fastapi"* ]]; then
    IS_PY=true
  fi
  if [[ "$languages" == *"javascript"* ]] || [[ "$languages" == *"typescript"* ]] || \
     [[ "$scope_text" == *"node"* ]] || [[ "$scope_text" == *"react"* ]] || \
     [[ "$scope_text" == *"next"* ]]; then
    IS_JS=true
  fi
  if [[ "$languages" == *"go"* ]] || [[ "$scope_text" == *"golang"* ]]; then
    IS_GO=true
  fi

  # Priority 3: file detection (only if nothing found yet)
  if ! $IS_PY && ! $IS_JS && ! $IS_GO; then
    [[ -f "package.json" ]] && IS_JS=true
    [[ -f "requirements.txt" || -f "pyproject.toml" || -f "setup.py" || -f "Pipfile" ]] && IS_PY=true
    [[ -f "go.mod" ]] && IS_GO=true
  fi

  echo "$IS_PY $IS_JS $IS_GO"
}
