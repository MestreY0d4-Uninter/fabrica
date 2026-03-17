/**
 * Stack detection and normalization.
 * Direct port from genesis/scripts/stack-detection-lib.sh.
 */
import type { CanonicalStack, DeliveryTarget } from "../types.js";

const NORMALIZE_MAP: Record<string, CanonicalStack> = {
  nextjs: "nextjs", "next.js": "nextjs", next: "nextjs", "next-js": "nextjs",
  "node-cli": "node-cli", "node_cli": "node-cli", "node cli": "node-cli",
  "typescript-cli": "node-cli", "typescript cli": "node-cli",
  "ts-cli": "node-cli", "ts cli": "node-cli",
  "javascript-cli": "node-cli", "javascript cli": "node-cli",
  express: "express", "express.js": "express", "express-js": "express",
  fastapi: "fastapi", "fast-api": "fastapi",
  flask: "flask",
  django: "django",
  "python-cli": "python-cli", "python_cli": "python-cli", pycli: "python-cli",
  go: "go", golang: "go",
  java: "java", spring: "java", "spring-boot": "java",
};

/** Normalize a user-supplied stack hint to a canonical stack name. Returns empty string if unknown. */
export function normalizeStackHint(raw: string): CanonicalStack | "" {
  if (!raw) return "";
  const key = raw.toLowerCase().trim();
  return NORMALIZE_MAP[key] ?? "";
}

const STACK_PATTERNS: Array<[RegExp, CanonicalStack]> = [
  [/\b(golang|go)\b.*\b(cli|command line|linha de comando|terminal|console|subcommand|subcomando)\b|\b(cli|command line|linha de comando|terminal|console|subcommand|subcomando)\b.*\b(golang|go)\b/i, "go"],
  [/\b(linguagem de implementa[cç][aã]o|implementation language|stack sugerida|tecnologias sugeridas)[:\s-].*\bgo\b|\b(go ou rust|rust ou go)\b/i, "go"],
  [/\b(next\.?js|nextjs|react\s+ssr)\b/i, "nextjs"],
  [/\b(node[\s-]?cli|typescript[\s-]?cli|ts[\s-]?cli|javascript[\s-]?cli|commander\b|yargs\b|oclif\b)\b/i, "node-cli"],
  [/\b(cli|command line|linha de comando|terminal|console|subcommand|subcomando)\b.*\b(node|typescript|javascript|npm)\b|\b(node|typescript|javascript|npm)\b.*\b(cli|command line|linha de comando|terminal|console|subcommand|subcomando)\b/i, "node-cli"],
  [/\b(express\.?js|express|node\.?js.*api|node.*server)\b/i, "express"],
  [/\b(fastapi|fast-api|uvicorn)\b/i, "fastapi"],
  [/\b(flask)\b/i, "flask"],
  [/\b(django)\b/i, "django"],
  [/\b(python.*cli|cli.*python|argparse|click|typer)\b/i, "python-cli"],
  [/\b(golang|go\s+api|go\s+server|gin|fiber|echo)\b/i, "go"],
  [/\b(java|spring|spring-boot|springboot|maven|gradle)\b/i, "java"],
];

/** Detect stack from text content (spec, idea, etc.) */
export function detectStackFromText(text: string): CanonicalStack | "" {
  for (const [pattern, stack] of STACK_PATTERNS) {
    if (pattern.test(text)) return stack;
  }
  return "";
}

const DELIVERY_TARGET_DEFAULTS: Partial<Record<DeliveryTarget, CanonicalStack>> = {
  "web-ui": "nextjs",
  api: "fastapi",
  cli: "python-cli",
  hybrid: "nextjs",
};

/** Fallback stack detection from delivery target. */
export function detectStackFromDeliveryTarget(target: DeliveryTarget): CanonicalStack {
  return DELIVERY_TARGET_DEFAULTS[target] ?? "fastapi";
}

export type StackFlags = {
  IS_PY: boolean;
  IS_JS: boolean;
  IS_GO: boolean;
};

/** Get language flags for a canonical stack. */
export function getStackFlags(stack: CanonicalStack): StackFlags {
  switch (stack) {
    case "nextjs":
    case "node-cli":
    case "express":
      return { IS_PY: false, IS_JS: true, IS_GO: false };
    case "fastapi":
    case "flask":
    case "django":
    case "python-cli":
      return { IS_PY: true, IS_JS: false, IS_GO: false };
    case "go":
      return { IS_PY: false, IS_JS: false, IS_GO: true };
    case "java":
      return { IS_PY: false, IS_JS: false, IS_GO: false };
    default:
      return { IS_PY: false, IS_JS: false, IS_GO: false };
  }
}
