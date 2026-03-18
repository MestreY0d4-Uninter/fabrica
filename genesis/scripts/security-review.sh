#!/usr/bin/env bash
set -euo pipefail

# Step 8: Security review — run SecureClaw audit + pattern matching on spec
# Input: stdin JSON (session state)
# Output: JSON with security findings to stdout

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECURECLAW_AUDIT="$HOME/.openclaw/extensions/secureclaw/skill/scripts/quick-audit.sh"

if [[ -n "${1:-}" && -f "${1:-}" ]]; then
  INPUT="$(cat "$1")"
else
  INPUT="$(cat)"
fi
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id')"
SPEC="$(echo "$INPUT" | jq '.spec // {}')"
METADATA="$(echo "$INPUT" | jq '.metadata // {}')"
CLASSIFICATION="$(echo "$INPUT" | jq '.classification // {}')"
INTERVIEW="$(echo "$INPUT" | jq '.interview // {}')"
IMPACT="$(echo "$INPUT" | jq '.impact // {}')"
QA_CONTRACT="$(echo "$INPUT" | jq '.qa_contract // {}')"
PROJECT_MAP="$(echo "$INPUT" | jq '.project_map // {}')"
SCAFFOLD="$(echo "$INPUT" | jq '.scaffold // {}')"

echo "Running security review for session $SESSION_ID..." >&2

# Run SecureClaw audit if available
AUDIT_RAN=false
AUDIT_SCORE=0
AUDIT_FINDINGS="[]"

if [[ -f "$SECURECLAW_AUDIT" ]]; then
  echo "Running SecureClaw quick-audit..." >&2
  AUDIT_OUTPUT="$(bash "$SECURECLAW_AUDIT" 2>&1 || true)"
  AUDIT_RAN=true

  # Extract score
  AUDIT_SCORE="$(echo "$AUDIT_OUTPUT" | grep -oP 'Security Score: \K[0-9]+' || echo "0")"

  # Extract findings (FAIL lines)
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    AUDIT_FINDINGS="$(echo "$AUDIT_FINDINGS" | jq --arg f "$line" '. + [$f]')"
  done < <(echo "$AUDIT_OUTPUT" | grep -E '🔴|🟠|🟡' | sed 's/^[[:space:]]*//' || true)

  echo "SecureClaw score: $AUDIT_SCORE/100" >&2
else
  echo "SecureClaw not installed — skipping audit" >&2
fi

# Pattern matching on spec for security concerns
SPEC_TEXT="$(echo "$SPEC" | jq -r '[.title, .objective, (.scope_v1 // [] | .[]), (.acceptance_criteria // [] | .[])] | join(" ")' | tr '[:upper:]' '[:lower:]')"
AUTH_SIGNAL_FROM_META="$(echo "$INPUT" | jq -r '.metadata.auth_gate.signal // false')"
AUTH_EVIDENCE_FROM_META="$(echo "$INPUT" | jq -r '.metadata.auth_gate.evidence // false')"

SECURITY_NOTES="[]"

# Check for common security-sensitive patterns
declare -A PATTERNS=(
  ["auth"]="Authentication/authorization detected — ensure proper session management, password hashing, and token validation"
  ["login"]="Login flow detected — protect against brute force, credential stuffing, and session fixation"
  ["password"]="Password handling detected — use bcrypt/argon2, never store plaintext"
  ["api"]="API detected — validate all inputs, implement rate limiting, use HTTPS"
  ["database"]="Database access detected — use parameterized queries, prevent SQL injection"
  ["banco de dados"]="Database access detected — use parameterized queries, prevent SQL injection"
  ["upload"]="File upload detected — validate file types, limit size, scan for malware"
  ["payment"]="Payment processing detected — PCI DSS compliance required"
  ["pagamento"]="Payment processing detected — PCI DSS compliance required"
  ["email"]="Email handling detected — sanitize inputs, prevent header injection"
  ["jwt"]="JWT detected — validate signatures, check expiration, use strong secrets"
  ["token"]="Token handling detected — secure storage, rotation policy, revocation"
  ["admin"]="Admin functionality detected — enforce RBAC, audit logging"
  ["webhook"]="Webhook detected — validate signatures, implement replay protection"
  ["secret"]="Secrets handling detected — use env vars or vault, never hardcode"
  ["encrypt"]="Encryption detected — use standard libraries, proper key management"
  ["criptograf"]="Encryption detected — use standard libraries, proper key management"
)

for pattern in "${!PATTERNS[@]}"; do
  if [[ "$SPEC_TEXT" == *"$pattern"* ]]; then
    SECURITY_NOTES="$(echo "$SECURITY_NOTES" | jq --arg n "${PATTERNS[$pattern]}" '. + [$n]')"
  fi
done

if [[ "$AUTH_SIGNAL_FROM_META" == "true" ]]; then
  SECURITY_NOTES="$(echo "$SECURITY_NOTES" | jq '. + ["Auth/perfil requirement detected from intake context. Keep authz/authn checks mandatory in implementation and review."]')"
  if [[ "$AUTH_EVIDENCE_FROM_META" != "true" ]]; then
    SECURITY_NOTES="$(echo "$SECURITY_NOTES" | jq '. + ["Potential contract drift: auth signal detected without explicit acceptance evidence in spec."]')"
  fi
fi

NOTE_COUNT="$(echo "$SECURITY_NOTES" | jq 'length')"

# Recommendation
if [[ "$AUTH_SIGNAL_FROM_META" == "true" && "$AUTH_EVIDENCE_FROM_META" != "true" ]]; then
  RECOMMENDATION="HIGH security sensitivity — auth requirements appear incomplete and must be reconciled before dispatch"
elif [[ "$NOTE_COUNT" -gt 3 ]]; then
  RECOMMENDATION="HIGH security sensitivity — require security-focused code review and penetration testing before release"
elif [[ "$NOTE_COUNT" -gt 0 ]]; then
  RECOMMENDATION="MODERATE security sensitivity — standard security review during code review phase"
else
  RECOMMENDATION="LOW security sensitivity — standard QA gates should suffice"
fi

echo "Security notes: $NOTE_COUNT concerns found. $RECOMMENDATION" >&2

jq -n \
  --arg sid "$SESSION_ID" \
  --argjson audit_ran "$AUDIT_RAN" \
  --argjson score "$AUDIT_SCORE" \
  --argjson findings "$AUDIT_FINDINGS" \
  --argjson notes "$SECURITY_NOTES" \
  --arg rec "$RECOMMENDATION" \
  --argjson spec "$SPEC" \
  --argjson cls "$CLASSIFICATION" \
  --argjson interview "$INTERVIEW" \
  --argjson impact "$IMPACT" \
  --argjson qa "$QA_CONTRACT" \
  --argjson map "$PROJECT_MAP" \
  --argjson scaffold "$SCAFFOLD" \
  --argjson meta "$METADATA" \
  '{
    session_id: $sid,
    step: "security",
    security: {
      audit_ran: $audit_ran,
      score: $score,
      findings: $findings,
      spec_security_notes: $notes,
      recommendation: $rec
    },
    spec: $spec,
    classification: $cls,
    interview: $interview,
    impact: $impact,
    qa_contract: $qa,
    project_map: $map,
    scaffold: $scaffold,
    metadata: $meta
  }'
