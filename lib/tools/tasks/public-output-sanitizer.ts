export type PublicOutputViolation = "secret" | "path" | "env_dump";

const SECRET_PATTERNS = [
  /\b(?:ghp_|gho_|github_pat_|sk-|xoxb-|xoxp-|AIza|AKIA|glpat-)[A-Za-z0-9._-]*/g,
  /\b(?:token|secret|api[_-]?key|password|passwd|authorization|bearer)\b\s*[:=]\s*[^\s]+/gi,
];

const PATH_PATTERNS = [
  /\/home\/[^\s)"'`]+/g,
  /~\/\.openclaw[^\s)"'`]+/g,
  /\/Users\/[^\s)"'`]+/g,
  /\/tmp\/[^\s)"'`]+/g,
  /[A-Za-z]:\\(?:Users|Windows|Temp)\\[^\s)"'`]+/g,
];

const ENV_DUMP_PATTERNS = [
  /^.*\b(?:printenv|declare -x|export\s+[A-Z_][A-Z0-9_]*=|env)\b.*$/gim,
];

export function findPublicOutputViolations(input: string): PublicOutputViolation[] {
  const violations = new Set<PublicOutputViolation>();
  if (!input) return [];

  if (SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(input);
  })) {
    violations.add("secret");
  }
  if (PATH_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(input);
  })) {
    violations.add("path");
  }
  if (ENV_DUMP_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(input);
  })) {
    violations.add("env_dump");
  }

  return [...violations];
}

export function sanitizePublicOutput(input: string): string {
  let output = input;

  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, "[REDACTED_SECRET]");
  }
  for (const pattern of PATH_PATTERNS) {
    output = output.replace(pattern, "[REDACTED_PATH]");
  }
  for (const pattern of ENV_DUMP_PATTERNS) {
    output = output.replace(pattern, "[REDACTED_ENV_OUTPUT]");
  }

  return output;
}
