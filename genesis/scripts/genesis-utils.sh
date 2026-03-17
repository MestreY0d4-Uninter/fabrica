#!/usr/bin/env bash

# genesis-utils.sh — Shared utility functions for Genesis pipeline
# Extracted from sideband-lib.sh to allow lighter imports.
# sideband-lib.sh sources this file for backward compatibility.
# shellcheck shell=bash

if [ -z "${BASH_VERSION:-}" ]; then
  echo "ERROR: genesis-utils.sh requires bash." >&2
  return 1 2>/dev/null || exit 1
fi

# Guard against double-sourcing
[[ -n "${_GENESIS_UTILS_LOADED:-}" ]] && return 0
_GENESIS_UTILS_LOADED=1

set -euo pipefail

# === Category A: Stateless Parsing & Validation ===

genesis_trim() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s\n' "$value"
}

genesis_load_env_file() {
  local env_file="${1:-$HOME/.openclaw/.env}"
  local line key value

  [[ -f "$env_file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="$(genesis_trim "$line")"
    [[ -z "$line" || "$line" == \#* ]] && continue

    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      value="${value%$'\r'}"
      if [[ "$value" == \"*\" && "$value" == *\" && "${#value}" -ge 2 ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "$value" == \'*\' && "$value" == *\' && "${#value}" -ge 2 ]]; then
        value="${value:1:${#value}-2}"
      else
        value="${value%%[[:space:]]#*}"
        value="$(genesis_trim "$value")"
      fi
      export "$key=$value"
    fi
  done < "$env_file"
}

genesis_parse_owner_repo() {
  local raw="${1:-}"
  local normalized owner repo

  normalized="$(genesis_trim "$raw")"
  [[ -n "$normalized" ]] || return 1

  normalized="${normalized#https://github.com/}"
  normalized="${normalized#http://github.com/}"
  normalized="${normalized#ssh://git@github.com/}"
  normalized="${normalized#git@github.com:}"
  normalized="${normalized#git://github.com/}"
  normalized="${normalized%.git}"
  normalized="${normalized%/}"

  if [[ "$normalized" != */* ]]; then
    return 1
  fi

  owner="${normalized%%/*}"
  repo="${normalized#*/}"

  if [[ -z "$owner" || -z "$repo" || "$repo" == */* ]]; then
    return 1
  fi
  if [[ ! "$owner" =~ ^[A-Za-z0-9._-]+$ ]]; then
    return 1
  fi
  if [[ ! "$repo" =~ ^[A-Za-z0-9._-]+$ ]]; then
    return 1
  fi

  printf '%s/%s\n' "$owner" "$repo"
}

genesis_repo_key() {
  local raw="${1:-}"
  local owner_repo
  owner_repo="$(genesis_parse_owner_repo "$raw" 2>/dev/null || true)"
  [[ -n "$owner_repo" ]] || return 1
  printf '%s\n' "$(echo "$owner_repo" | tr '[:upper:]' '[:lower:]')"
}

genesis_expand_path() {
  local raw_path="${1:-}"
  local path
  path="$(genesis_trim "$raw_path")"
  case "$path" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${path#\~/}" ;;
    *) printf '%s\n' "$path" ;;
  esac
}

genesis_bool_is_true() {
  local value
  value="$(genesis_trim "${1:-}")"
  case "${value,,}" in
    true|1|yes|y|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

genesis_extract_answer_value() {
  local input_json="${1:-}"
  local key="${2:-}"
  [[ -n "$input_json" && -n "$key" ]] || return 1
  printf '%s' "$input_json" | jq -r --arg key "$key" '
    .answers[$key]
    // .metadata.answers[$key]
    // empty
  ' 2>/dev/null
}

# === Category B: Project Metadata Queries (projects.json Accessors) ===

genesis_find_project_slug_by_repo() {
  local raw_repo="${1:-}"
  local projects_file="${2:-$HOME/.openclaw/workspace/devclaw/projects.json}"
  local wanted line slug remote remote_key
  local -a matches=()
  wanted="$(genesis_repo_key "$raw_repo" 2>/dev/null || true)"
  [[ -n "$wanted" ]] || return 1
  [[ -f "$projects_file" ]] || return 1

  while IFS=$'\t' read -r slug remote; do
    [[ -n "$slug" && -n "$remote" ]] || continue
    remote_key="$(genesis_repo_key "$remote" 2>/dev/null || true)"
    [[ -n "$remote_key" ]] || continue
    if [[ "$remote_key" == "$wanted" ]]; then
      matches+=("$slug")
    fi
  done < <(jq -r '.projects | to_entries[] | [.key, (.value.repoRemote // .value.remote // .value.remoteUrl // "")] | @tsv' "$projects_file" 2>/dev/null || true)

  if (( ${#matches[@]} == 1 )); then
    printf '%s\n' "${matches[0]}"
    return 0
  fi

  return 1
}

genesis_project_primary_channel_id() {
  local slug="${1:-}"
  local projects_file="${2:-$HOME/.openclaw/workspace/devclaw/projects.json}"
  [[ -n "$slug" ]] || return 1
  [[ -f "$projects_file" ]] || return 1
  jq -r --arg slug "$slug" '.projects[$slug].channels // [] | map(select((.channelId // "") != "")) | .[0].channelId // empty' "$projects_file" 2>/dev/null
}

genesis_project_exists() {
  local slug="${1:-}"
  local projects_file="${2:-$HOME/.openclaw/workspace/devclaw/projects.json}"
  [[ -n "$slug" && -f "$projects_file" ]] || return 1
  jq -e --arg slug "$slug" '.projects[$slug] != null' "$projects_file" >/dev/null 2>&1
}

genesis_project_remote() {
  local slug="${1:-}"
  local projects_file="${2:-$HOME/.openclaw/workspace/devclaw/projects.json}"
  [[ -n "$slug" && -f "$projects_file" ]] || return 1
  jq -r --arg slug "$slug" '.projects[$slug].repoRemote // .projects[$slug].remote // .projects[$slug].remoteUrl // empty' "$projects_file" 2>/dev/null
}

genesis_project_channel_id() {
  local slug="${1:-}"
  local requested_channel_id="${2:-}"
  local projects_file="${3:-$HOME/.openclaw/workspace/devclaw/projects.json}"
  local requested

  requested="$(genesis_trim "$requested_channel_id")"
  [[ -n "$slug" && -f "$projects_file" ]] || return 1
  genesis_project_exists "$slug" "$projects_file" || return 1

  if [[ -n "$requested" ]]; then
    if jq -e --arg slug "$slug" --arg cid "$requested" \
      '.projects[$slug].channels // [] | map(select((.channelId // "") == $cid)) | length > 0' \
      "$projects_file" >/dev/null 2>&1; then
      printf '%s\n' "$requested"
      return 0
    fi
  fi

  jq -r --arg slug "$slug" '
    .projects[$slug].channels // []
    | (
        map(select((.channelId // "") != "" and ((.name // "") | ascii_downcase) == "primary"))[0].channelId
        // map(select((.channelId // "") != ""))[0].channelId
        // empty
      )
  ' "$projects_file" 2>/dev/null
}

genesis_project_resolve_ref() {
  local ref="${1:-}"
  local projects_file="${2:-$HOME/.openclaw/workspace/devclaw/projects.json}"
  local normalized

  normalized="$(genesis_trim "$ref")"
  [[ -n "$normalized" && -f "$projects_file" ]] || return 1

  jq -r --arg ref "$normalized" '
    .projects
    | to_entries
    | map(
        .value
        + {
            slug: .key,
            ref_key: (.key | ascii_downcase),
            ref_name: ((.value.name // "") | ascii_downcase),
            ref_repo_name: (
              (
                .value.repoRemote
                // .value.remote
                // .value.remoteUrl
                // .value.repo
                // ""
              )
              | sub("^https?://github.com/"; "")
              | sub("^ssh://git@github.com/"; "")
              | sub("^git@github.com:"; "")
              | sub("^git://github.com/"; "")
              | sub("\\.git$"; "")
              | split("/")
              | last
              | ascii_downcase
            )
          }
      )
    | map(select(
        .ref_key == ($ref | ascii_downcase)
        or .ref_name == ($ref | ascii_downcase)
        or .ref_repo_name == ($ref | ascii_downcase)
      ))
    | .[0]
    | select(.slug != null)
    | [
        .slug,
        (.name // ""),
        (.repoRemote // .remote // .remoteUrl // ""),
        (.repo // "")
      ]
    | @tsv
  ' "$projects_file" 2>/dev/null
}

genesis_project_kind() {
  local slug="${1:-}"
  local projects_file="${2:-$HOME/.openclaw/workspace/devclaw/projects.json}"
  [[ -n "$slug" && -f "$projects_file" ]] || return 1
  jq -r --arg slug "$slug" '.projects[$slug].projectKind // "implementation"' "$projects_file" 2>/dev/null
}

genesis_project_archived() {
  local slug="${1:-}"
  local projects_file="${2:-$HOME/.openclaw/workspace/devclaw/projects.json}"
  [[ -n "$slug" && -f "$projects_file" ]] || return 1
  jq -r --arg slug "$slug" '
    (
      .projects[$slug].archived // false
    ) or (
      (.projects[$slug].projectKind // "") == "archived_duplicate"
    )
  ' "$projects_file" 2>/dev/null
}

genesis_project_default_notify_channel() {
  local slug="${1:-}"
  local projects_file="${2:-$HOME/.openclaw/workspace/devclaw/projects.json}"
  [[ -n "$slug" && -f "$projects_file" ]] || return 1
  jq -r --arg slug "$slug" '.projects[$slug].defaultNotifyChannel // empty' "$projects_file" 2>/dev/null
}

genesis_repo_target_candidate() {
  local raw="${1:-}"
  local trimmed owner_repo after_colon candidate

  trimmed="$(genesis_trim "$raw")"
  [[ -n "$trimmed" ]] || return 1

  owner_repo="$(genesis_parse_owner_repo "$trimmed" 2>/dev/null || true)"
  if [[ -n "$owner_repo" ]]; then
    printf '%s\n' "$owner_repo"
    return 0
  fi

  if [[ "$trimmed" == *:* ]]; then
    after_colon="$(genesis_trim "${trimmed##*:}")"
    owner_repo="$(genesis_parse_owner_repo "$after_colon" 2>/dev/null || true)"
    if [[ -n "$owner_repo" ]]; then
      printf '%s\n' "$owner_repo"
      return 0
    fi
    if [[ "$after_colon" =~ ^[A-Za-z0-9._-]{3,100}$ ]]; then
      printf '%s\n' "$after_colon"
      return 0
    fi
  fi

  candidate="$(printf '%s' "$trimmed" | sed -E 's/^[[:space:]]*(novo|new|existente|existing|repo|repositorio|reposit[oó]rio|projeto|project)[[:space:]]*[:=-]?[[:space:]]*//I')"
  candidate="$(genesis_trim "$candidate")"
  owner_repo="$(genesis_parse_owner_repo "$candidate" 2>/dev/null || true)"
  if [[ -n "$owner_repo" ]]; then
    printf '%s\n' "$owner_repo"
    return 0
  fi
  if [[ "$candidate" =~ ^[A-Za-z0-9._-]{3,100}$ ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

genesis_resolve_canonical_target() {
  local input_json="${1:-}"
  local projects_file="${2:-$HOME/.openclaw/workspace/devclaw/projects.json}"
  local explicit_repo candidate_slug repo_target_raw repo_target_candidate
  local resolved_repo="" resolved_slug="" resolved_name="" source=""
  local project_ref resolved_remote owner_repo

  [[ -n "$input_json" ]] || {
    jq -n '{metadata:{}}'
    return 0
  }

  explicit_repo="$(printf '%s' "$input_json" | jq -r '
    .scaffold.repo_url
    // .metadata.repo_url
    // .repo_url
    // .repo
    // empty
  ' 2>/dev/null || true)"
  candidate_slug="$(printf '%s' "$input_json" | jq -r '
    .project_slug
    // .metadata.project_slug
    // .scaffold.project_slug
    // .metadata.project_name
    // .project_name
    // .repo_name
    // empty
  ' 2>/dev/null || true)"
  repo_target_raw="$(genesis_extract_answer_value "$input_json" "repo_target" || true)"
  repo_target_candidate="$(genesis_repo_target_candidate "$repo_target_raw" || true)"

  explicit_repo="$(genesis_trim "$explicit_repo")"
  candidate_slug="$(genesis_trim "$candidate_slug")"
  repo_target_candidate="$(genesis_trim "$repo_target_candidate")"

  if [[ -n "$explicit_repo" ]]; then
    owner_repo="$(genesis_parse_owner_repo "$explicit_repo" 2>/dev/null || true)"
    if [[ -n "$owner_repo" ]]; then
      resolved_repo="https://github.com/$owner_repo"
      source="explicit_repo_url"
    else
      project_ref="$(genesis_project_resolve_ref "$explicit_repo" "$projects_file" || true)"
      if [[ -n "$project_ref" ]]; then
        resolved_slug="$(printf '%s' "$project_ref" | cut -f1)"
        resolved_name="$(printf '%s' "$project_ref" | cut -f2)"
        resolved_remote="$(printf '%s' "$project_ref" | cut -f3)"
        if [[ -n "$resolved_remote" ]]; then
          resolved_repo="$resolved_remote"
        fi
        source="explicit_repo_ref"
      fi
    fi
  fi

  if [[ -z "$resolved_slug" && -n "$candidate_slug" ]]; then
    if genesis_project_exists "$candidate_slug" "$projects_file"; then
      resolved_slug="$candidate_slug"
      resolved_remote="$(genesis_project_remote "$candidate_slug" "$projects_file" || true)"
      if [[ -n "$resolved_remote" ]]; then
        resolved_repo="$resolved_remote"
      fi
      [[ -n "$source" ]] || source="explicit_project_slug"
    else
      project_ref="$(genesis_project_resolve_ref "$candidate_slug" "$projects_file" || true)"
      if [[ -n "$project_ref" ]]; then
        resolved_slug="$(printf '%s' "$project_ref" | cut -f1)"
        resolved_name="$(printf '%s' "$project_ref" | cut -f2)"
        resolved_remote="$(printf '%s' "$project_ref" | cut -f3)"
        if [[ -n "$resolved_remote" ]]; then
          resolved_repo="$resolved_remote"
        fi
        [[ -n "$source" ]] || source="project_ref"
      fi
    fi
  fi

  if [[ -z "$resolved_slug" && -z "$resolved_repo" && -n "$repo_target_candidate" ]]; then
    owner_repo="$(genesis_parse_owner_repo "$repo_target_candidate" 2>/dev/null || true)"
    if [[ -n "$owner_repo" ]]; then
      resolved_repo="https://github.com/$owner_repo"
      resolved_slug="$(genesis_find_project_slug_by_repo "$resolved_repo" "$projects_file" || true)"
      source="answers.repo_target"
    else
      project_ref="$(genesis_project_resolve_ref "$repo_target_candidate" "$projects_file" || true)"
      if [[ -n "$project_ref" ]]; then
        resolved_slug="$(printf '%s' "$project_ref" | cut -f1)"
        resolved_name="$(printf '%s' "$project_ref" | cut -f2)"
        resolved_remote="$(printf '%s' "$project_ref" | cut -f3)"
        if [[ -n "$resolved_remote" ]]; then
          resolved_repo="$resolved_remote"
        fi
        source="answers.repo_target"
      fi
    fi
  fi

  if [[ -z "$resolved_slug" && -n "$resolved_repo" ]]; then
    resolved_slug="$(genesis_find_project_slug_by_repo "$resolved_repo" "$projects_file" || true)"
    if [[ -n "$resolved_slug" ]]; then
      [[ -n "$source" ]] || source="repo_remote"
    fi
  fi

  if [[ -n "$resolved_slug" && -z "$resolved_repo" ]]; then
    resolved_remote="$(genesis_project_remote "$resolved_slug" "$projects_file" || true)"
    if [[ -n "$resolved_remote" ]]; then
      resolved_repo="$resolved_remote"
    fi
  fi

  if [[ -z "$resolved_name" && -n "$resolved_slug" ]]; then
    resolved_name="$resolved_slug"
  fi

  jq -n \
    --arg repo_url "$resolved_repo" \
    --arg project_slug "$resolved_slug" \
    --arg project_name "$resolved_name" \
    --arg repo_target_source "$source" \
    '{
      metadata: (
        {}
        + (if $repo_url != "" then {repo_url: $repo_url} else {} end)
        + (if $project_slug != "" then {project_slug: $project_slug} else {} end)
        + (if $project_name != "" then {project_name: $project_name} else {} end)
        + (if $repo_target_source != "" then {repo_target_source: $repo_target_source} else {} end)
      )
    }'
}

# === Category D: OpenClaw CLI Execution ===

genesis_openclaw_bin() {
  local candidate
  local -a candidates=(
    "${OPENCLAW_BIN:-}"
    "$(command -v openclaw 2>/dev/null || true)"
    "$HOME/.nvm/versions/node/v24.14.0/bin/openclaw"
    "$HOME/.local/bin/openclaw"
    "/usr/local/bin/openclaw"
  )

  while IFS= read -r candidate; do
    candidates+=("$candidate")
  done < <(ls -1d "$HOME"/.nvm/versions/node/v*/bin/openclaw 2>/dev/null || true)

  for candidate in "${candidates[@]}"; do
    [[ -n "$candidate" ]] || continue
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

genesis_openclaw_timeout_sec() {
  local raw
  raw="$(genesis_trim "${GENESIS_OPENCLAW_TIMEOUT_SEC:-75}")"
  if [[ "$raw" =~ ^[0-9]+$ ]] && [[ "$raw" -ge 5 ]] && [[ "$raw" -le 900 ]]; then
    printf '%s\n' "$raw"
    return 0
  fi
  printf '75\n'
}

genesis_openclaw_retries() {
  local raw
  raw="$(genesis_trim "${GENESIS_OPENCLAW_RETRIES:-1}")"
  if [[ "$raw" =~ ^[0-9]+$ ]] && [[ "$raw" -ge 1 ]] && [[ "$raw" -le 3 ]]; then
    printf '%s\n' "$raw"
    return 0
  fi
  printf '1\n'
}

genesis_openclaw_retry_delay_sec() {
  local raw
  raw="$(genesis_trim "${GENESIS_OPENCLAW_RETRY_DELAY_SEC:-2}")"
  if [[ "$raw" =~ ^[0-9]+$ ]] && [[ "$raw" -ge 1 ]] && [[ "$raw" -le 30 ]]; then
    printf '%s\n' "$raw"
    return 0
  fi
  printf '2\n'
}

genesis_openclaw_exec() {
  local openclaw_bin openclaw_dir timeout_sec
  if ! openclaw_bin="$(genesis_openclaw_bin)"; then
    echo "ERROR: OpenClaw CLI not found. Set OPENCLAW_BIN or add openclaw to PATH." >&2
    return 127
  fi
  openclaw_dir="$(dirname "$openclaw_bin")"
  timeout_sec="$(genesis_openclaw_timeout_sec)"
  if command -v timeout >/dev/null 2>&1; then
    PATH="$openclaw_dir:$PATH" timeout --signal=TERM --kill-after=5s "${timeout_sec}s" "$openclaw_bin" "$@"
  else
    PATH="$openclaw_dir:$PATH" "$openclaw_bin" "$@"
  fi
}

genesis_openclaw_supports() {
  [[ "$#" -gt 0 ]] || return 1
  local raw_args=("$@")
  local args=()
  local word
  for word in "${raw_args[@]}"; do
    # shellcheck disable=SC2206
    args+=($word)
  done
  [[ "${#args[@]}" -gt 0 ]] || return 1
  local i parent_help child
  for (( i=0; i<${#args[@]}; i++ )); do
    child="${args[$i]}"
    if (( i == 0 )); then
      parent_help="$(genesis_openclaw_exec --help 2>&1)" || true
      if ! echo "$parent_help" | grep -qE "^[[:space:]]+${child}([[:space:]]|$)"; then
        genesis_openclaw_exec "$child" --help >/dev/null 2>&1 || return 1
      fi
    else
      parent_help="$(genesis_openclaw_exec "${args[@]:0:$i}" --help 2>&1)" || return 1
      if ! echo "$parent_help" | grep -qE "^[[:space:]]+${child}([[:space:]]|$)"; then
        return 1
      fi
    fi
  done
  return 0
}

genesis_devclaw_task_json() {
  local attempts delay try status
  attempts="$(genesis_openclaw_retries)"
  delay="$(genesis_openclaw_retry_delay_sec)"
  try=1

  while true; do
    if genesis_openclaw_exec devclaw task "$@" --json; then
      return 0
    fi
    status=$?
    if [[ "$try" -ge "$attempts" ]]; then
      return "$status"
    fi
    echo "WARN: DevClaw task call failed (attempt $try/$attempts, exit=$status). Retrying in ${delay}s..." >&2
    sleep "$delay"
    try=$((try + 1))
  done
}

# === Category E: Factory Logic Detectors ===

genesis_is_factory_project_slug() {
  local slug
  slug="$(genesis_trim "${1:-}")"
  [[ -n "$slug" ]] || return 1
  case "${slug,,}" in
    devclaw-automation|factory-*|fabrica-*|genesis-router)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

genesis_request_is_factory_change() {
  local text
  text="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [[ -n "$text" ]] || return 1
  printf '%s\n' "$text" | grep -Eq 'internal|interna|interno|melhoria da f[aá]brica|factory (core|internal)|openclaw|devclaw|genesis|pipeline|workflow|triage|register-project|create-task|scaffold-project|sideband|projects\.json|~\/\.openclaw'
}

genesis_payload_factory_change() {
  local input="${1:-}"
  local raw
  [[ -n "$input" ]] || return 1
  raw="$(echo "$input" | jq -r '
    .factory_change
    // .metadata.factory_change
    // .scaffold.factory_change
    // empty
  ' 2>/dev/null || true)"
  genesis_bool_is_true "$raw"
}
