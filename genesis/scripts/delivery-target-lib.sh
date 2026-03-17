#!/usr/bin/env bash
set -euo pipefail

genesis_normalize_delivery_target() {
  local raw="${1:-}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[[:space:]_]+/-/g')"
  case "$raw" in
    web|web-ui|webui|frontend|front-end|ui|interface|site|website|pwa)
      printf '%s' "web-ui"
      ;;
    api|backend|service|rest|graphql|webhook)
      printf '%s' "api"
      ;;
    cli|terminal|console|command-line|linha-de-comando)
      printf '%s' "cli"
      ;;
    hybrid|fullstack|full-stack)
      printf '%s' "hybrid"
      ;;
    *)
      printf '%s' "unknown"
      ;;
  esac
}

genesis_detect_delivery_target_from_text() {
  local text="${1:-}"
  local lower
  lower="$(printf '%s' "$text" | tr '[:upper:]' '[:lower:]')"

  local has_web="false"
  local has_api="false"
  local has_cli="false"

  if echo "$lower" | grep -Eqi '\b(app web|web app|site|website|frontend|front-end|interface|ui|ux|tela|página|pagina|dashboard|painel|pwa)\b'; then
    has_web="true"
  fi
  if echo "$lower" | grep -Eqi '\b(api|endpoint|backend|rest|graphql|webhook|serviço|servico)\b'; then
    has_api="true"
  fi
  if echo "$lower" | grep -Eqi '\b(cli|terminal|console|linha de comando|command line|comando|programinha|programa|script|calcular|converter|ferramenta)\b'; then
    has_cli="true"
  fi

  local count=0
  [[ "$has_web" == "true" ]] && count=$((count + 1))
  [[ "$has_api" == "true" ]] && count=$((count + 1))
  [[ "$has_cli" == "true" ]] && count=$((count + 1))

  if [[ "$count" -gt 1 ]]; then
    printf '%s' "hybrid"
    return 0
  fi
  if [[ "$has_web" == "true" ]]; then
    printf '%s' "web-ui"
    return 0
  fi
  if [[ "$has_api" == "true" ]]; then
    printf '%s' "api"
    return 0
  fi
  if [[ "$has_cli" == "true" ]]; then
    printf '%s' "cli"
    return 0
  fi

  printf '%s' "unknown"
}

genesis_cross_validate_delivery_target() {
  local spec_target="${1:-}"
  local raw_idea="${2:-}"
  local text_target
  text_target="$(genesis_detect_delivery_target_from_text "$raw_idea")"

  if [[ "$text_target" != "unknown" && "$spec_target" != "unknown" && "$text_target" != "$spec_target" ]]; then
    echo "WARNING: delivery_target conflict — spec='$spec_target' vs text='$text_target'. Preferring text." >&2
    printf '%s' "$text_target"
    return 0
  fi

  if [[ "$spec_target" == "unknown" && "$text_target" != "unknown" ]]; then
    printf '%s' "$text_target"
    return 0
  fi

  printf '%s' "$spec_target"
}
