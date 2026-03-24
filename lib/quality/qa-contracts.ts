/**
 * QA contract generation — stack-aware quality gates.
 *
 * Stack-aware QA contract generator.
 * Generates a qa.sh script with 5 mandatory gates (lint, types, security, tests, coverage)
 * configured per stack.
 */
import type { CanonicalStack, QaContract, Spec } from "../intake/types.js";
import { buildQaBootstrapPrelude, getQaGateCommands } from "../test-env/bootstrap.js";

// ---------------------------------------------------------------------------
// Stack-specific gate commands
// ---------------------------------------------------------------------------

const GATE_NAMES = ["lint", "types", "security", "tests", "coverage"] as const;
const COVERAGE_THRESHOLD = 80;

/**
 * Generate a QA contract (qa.sh script + gates + acceptance tests).
 */
export function generateQaContract(opts: {
  spec: Spec;
  stack: CanonicalStack;
  acceptanceCriteria?: string[];
}): QaContract {
  const { spec, stack, acceptanceCriteria } = opts;
  const cmds = getQaGateCommands(stack);
  const acs = acceptanceCriteria ?? spec.acceptance_criteria;
  const script = buildQaScript(cmds, stack, acs);

  return {
    gates: [...GATE_NAMES],
    acceptance_tests: acs,
    script_content: script,
  };
}

function buildQaScript(
  cmds: ReturnType<typeof getQaGateCommands>,
  stack: CanonicalStack,
  acs: string[],
): string {
  const acComments = acs
    .map((ac, i) => `# AC${i + 1}: ${ac}`)
    .join("\n");

  return `#!/usr/bin/env bash
# qa.sh — Generated QA contract
# Stack: ${stack}
# Coverage threshold: ${COVERAGE_THRESHOLD}%
#
# Acceptance Criteria:
${acComments}

set -euo pipefail

${buildQaBootstrapPrelude(stack)}

PASS=0
FAIL=0

gate() {
  local name="\$1"
  shift
  echo "=== Gate: \$name ==="
  if "\$@"; then
    echo "✅ \$name PASSED"
    PASS=\$((PASS + 1))
  else
    echo "❌ \$name FAILED"
    FAIL=\$((FAIL + 1))
  fi
  echo ""
}

# Gate 1: Lint
gate "lint" ${cmds.lint}

# Gate 2: Type checking
gate "types" ${cmds.types}

# Gate 3: Security audit
gate "security" ${cmds.security}

# Gate 4: Tests
gate "tests" ${cmds.tests}

# Gate 5: Coverage (>= ${COVERAGE_THRESHOLD}%)
gate "coverage" ${cmds.coverage}

echo ""
echo "=== QA Summary ==="
echo "PASS: \$PASS / FAIL: \$FAIL / TOTAL: \$((PASS + FAIL))"

if [ "\$FAIL" -gt 0 ]; then
  echo "❌ QA contract FAILED"
  exit 1
else
  echo "✅ QA contract PASSED"
  exit 0
fi
`;
}

/**
 * Get the standard gate names.
 */
export function getStandardGates(): readonly string[] {
  return GATE_NAMES;
}

/**
 * Get the coverage threshold.
 */
export function getCoverageThreshold(): number {
  return COVERAGE_THRESHOLD;
}

/**
 * Get gate commands for a stack (exported for testing).
 */
export { getQaGateCommands as getGateCommands };
