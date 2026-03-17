#!/usr/bin/env bash

# sideband-lib.sh — Genesis sideband IPC + shared utilities
# Now delegates utility functions to genesis-utils.sh.
# Existing callers that `source sideband-lib.sh` get all functions
# (utils + sideband IPC) for backward compatibility.
# shellcheck shell=bash

if [ -z "${BASH_VERSION:-}" ]; then
  echo "ERROR: sideband-lib.sh requires bash." >&2
  return 1 2>/dev/null || exit 1
fi

set -euo pipefail

# Load shared utilities (categories A-E: parsing, project queries, CLI, factory logic)
_SIDEBAND_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_SIDEBAND_LIB_DIR/genesis-utils.sh"

# === Category C: Sideband IPC Protocol (Secure Envelope Exchange) ===

genesis_sideband_dir() {
  local dir="${GENESIS_SIDEBAND_DIR:-$HOME/.openclaw/workspace/devclaw/sideband}"

  if [[ -L "$dir" ]]; then
    echo "ERROR: Sideband dir must not be a symlink: $dir" >&2
    return 1
  fi
  if [[ -e "$dir" && ! -d "$dir" ]]; then
    echo "ERROR: Sideband path is not a directory: $dir" >&2
    return 1
  fi

  if ! (umask 077 && mkdir -p "$dir"); then
    echo "ERROR: Failed to create sideband dir: $dir" >&2
    return 1
  fi
  chmod 700 "$dir" 2>/dev/null || true
  if [[ ! -d "$dir" || -L "$dir" || ! -O "$dir" ]]; then
    echo "ERROR: Sideband dir is not secure: $dir" >&2
    return 1
  fi

  printf '%s\n' "$dir"
}

genesis_sideband_secret() {
  local session_id="${1:-}"
  local secret="${GENESIS_SIDEBAND_SECRET:-${OPENCLAW_SIDEBAND_SECRET:-}}"

  if [[ -z "$secret" ]]; then
    local dir secret_file
    dir="$(genesis_sideband_dir)"
    secret_file="$dir/.genesis-sideband-secret"

    if [[ -f "$secret_file" ]]; then
      if [[ ! -O "$secret_file" || -L "$secret_file" ]]; then
        echo "ERROR: Sideband secret file is not secure: $secret_file" >&2
        return 1
      fi
      secret="$(head -n 1 "$secret_file" 2>/dev/null || true)"
    fi

    if [[ -z "$secret" ]]; then
      secret="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
      if [[ -z "$secret" ]]; then
        secret="$(hostname)-$(id -u)-${GENESIS_RUN_ID:-$session_id}"
      fi
      if ! (umask 077 && printf '%s\n' "$secret" > "$secret_file"); then
        echo "WARNING: Failed to persist sideband secret file; using in-memory secret" >&2
      fi
      chmod 600 "$secret_file" 2>/dev/null || true
    fi
  fi

  if [[ -z "$secret" ]]; then
    secret="$(hostname)-$(id -u)-${GENESIS_RUN_ID:-$session_id}"
  fi

  printf '%s\n' "$secret"
}

genesis_sideband_key() {
  local session_id="${1:-}"
  local seed=""

  # Use session_id as canonical key to keep sideband stable across workflow steps.
  # GENESIS_RUN_ID may vary depending on runner internals and must not break reads.
  if [[ -n "$session_id" ]]; then
    seed="$session_id"
  else
    seed="${GENESIS_RUN_ID:-}"
  fi

  if [[ -z "$seed" ]]; then
    echo "ERROR: Missing session seed for sideband key" >&2
    return 1
  fi

  printf '%s' "$seed" | sha256sum | cut -c1-24
}

genesis_sideband_signature() {
  local session_id="$1"
  local key="$2"
  local nonce="$3"
  local created_at="$4"
  local payload_json="$5"
  local secret
  secret="$(genesis_sideband_secret "$session_id")"
  printf '%s' "${secret}|${key}|${nonce}|${created_at}|${payload_json}" | sha256sum | cut -d' ' -f1
}

genesis_sideband_write() {
  local kind="$1"
  local session_id="$2"
  local payload_json="$3"

  local dir key nonce created_at signature tmp_path
  if [[ -z "$kind" || -z "$session_id" || -z "$payload_json" ]]; then
    echo "ERROR: genesis_sideband_write requires kind, session_id, and payload" >&2
    return 1
  fi

  dir="$(genesis_sideband_dir)"
  key="$(genesis_sideband_key "$session_id")"
  nonce="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  created_at="$(date +%s)"
  signature="$(genesis_sideband_signature "$session_id" "$key" "$nonce" "$created_at" "$payload_json")"

  tmp_path="$(mktemp "$dir/genesis-${key}-${kind}-${nonce}-XXXXXX.json")"
  chmod 600 "$tmp_path"

  if ! jq -n \
    --arg kind "$kind" \
    --arg key "$key" \
    --arg nonce "$nonce" \
    --argjson created_at "$created_at" \
    --arg signature "$signature" \
    --argjson payload "$payload_json" \
    '{
      kind: $kind,
      key: $key,
      nonce: $nonce,
      created_at: $created_at,
      signature: $signature,
      payload: $payload
    }' > "$tmp_path"; then
    rm -f "$tmp_path"
    return 1
  fi

  if [[ ! -O "$tmp_path" || -L "$tmp_path" ]]; then
    rm -f "$tmp_path"
    return 1
  fi

  printf '%s\n' "$tmp_path"
}

genesis_sideband_resolve() {
  local kind="$1"
  local session_id="$2"
  local key dir latest
  key="$(genesis_sideband_key "$session_id")"
  dir="$(genesis_sideband_dir)"

  latest="$(ls -1t -- "$dir"/genesis-"$key"-"$kind"-*.json 2>/dev/null | head -n 1 || true)"
  [[ -n "$latest" ]] || return 1
  printf '%s\n' "$latest"
}

genesis_sideband_read_payload() {
  local kind="$1"
  local session_id="$2"
  local ttl_seconds="${3:-1800}"

  local file_path now created_at key nonce signature payload_json expected expected_key perms

  if [[ ! "$ttl_seconds" =~ ^[0-9]+$ || "$ttl_seconds" -le 0 ]]; then
    ttl_seconds=1800
  fi

  if ! file_path="$(genesis_sideband_resolve "$kind" "$session_id" 2>/dev/null)"; then
    return 1
  fi
  if [[ ! -f "$file_path" ]]; then
    return 1
  fi
  if [[ ! -O "$file_path" || -L "$file_path" ]]; then
    return 1
  fi
  perms="$(stat -c '%a' "$file_path" 2>/dev/null || true)"
  if [[ -n "$perms" ]] && (( (8#$perms & 077) != 0 )); then
    return 1
  fi

  now="$(date +%s)"
  created_at="$(jq -r '.created_at // 0' "$file_path" 2>/dev/null || echo 0)"
  if [[ "$created_at" == "null" || "$created_at" == "" || ! "$created_at" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  if (( created_at > now + 60 )); then
    return 1
  fi
  if (( now - created_at > ttl_seconds )); then
    return 1
  fi

  key="$(jq -r '.key // ""' "$file_path" 2>/dev/null || true)"
  nonce="$(jq -r '.nonce // ""' "$file_path" 2>/dev/null || true)"
  signature="$(jq -r '.signature // ""' "$file_path" 2>/dev/null || true)"
  payload_json="$(jq -c '.payload' "$file_path" 2>/dev/null || true)"
  expected_key="$(genesis_sideband_key "$session_id")"

  if [[ -z "$key" || -z "$nonce" || -z "$signature" || -z "$payload_json" || "$payload_json" == "null" ]]; then
    return 1
  fi
  if [[ "$key" != "$expected_key" ]]; then
    return 1
  fi
  if [[ ! "$nonce" =~ ^[0-9a-f]{16,64}$ ]]; then
    return 1
  fi
  if [[ ! "$signature" =~ ^[0-9a-f]{64}$ ]]; then
    return 1
  fi

  expected="$(genesis_sideband_signature "$session_id" "$key" "$nonce" "$created_at" "$payload_json")"
  if [[ "$expected" != "$signature" ]]; then
    return 1
  fi

  printf '%s\n' "$payload_json"
}

genesis_sideband_cleanup() {
  local session_id="$1"
  local dir key
  dir="$(genesis_sideband_dir)"
  key="$(genesis_sideband_key "$session_id")"
  rm -f "$dir"/genesis-"$key"-*.json 2>/dev/null || true
}
