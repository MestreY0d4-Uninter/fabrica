/**
 * Delivery target detection and normalization.
 * Direct port from genesis/scripts/delivery-target-lib.sh.
 */
import type { DeliveryTarget } from "../types.js";

const NORMALIZE_MAP: Record<string, DeliveryTarget> = {
  web: "web-ui", "web-ui": "web-ui", webui: "web-ui", frontend: "web-ui",
  "front-end": "web-ui", ui: "web-ui", site: "web-ui",
  website: "web-ui", pwa: "web-ui",
  api: "api", backend: "api", service: "api", rest: "api",
  graphql: "api", webhook: "api",
  cli: "cli", terminal: "cli", console: "cli", "command-line": "cli",
  "linha-de-comando": "cli",
  hybrid: "hybrid", fullstack: "hybrid", "full-stack": "hybrid",
};

export function normalizeDeliveryTarget(raw: string): DeliveryTarget {
  const key = raw.toLowerCase().replace(/[\s_]+/g, "-");
  return NORMALIZE_MAP[key] ?? "unknown";
}

const WEB_PATTERNS = /\b(app web|web app|site|website|frontend|front-end|ux|tela|p[aá]gina|dashboard|painel|pwa|browser)\b/i;
const API_PATTERNS = /\b(api|endpoint|backend|rest|graphql|webhook|servi[çc]o)\b/i;
const CLI_PATTERNS = /\b(cli|terminal|console|linha de comando|command line|comando|programinha|programa|script|calcular|converter|ferramenta)\b/i;
const OPTIONAL_SECTION_PATTERNS = /\b(opcional|optional|roadmap|futur[oa]|future|posteriormente|later)\b/i;
const CLI_STRONG_PATTERNS = /\b(stack cli|ferramenta de linha de comando|command line tool|subcomando|subcommand|stack init|stack add|stack shell|stack run)\b/i;

export function detectDeliveryTargetFromText(text: string): DeliveryTarget {
  const scores = { web: 0, api: 0, cli: 0 };
  const coreScores = { web: 0, api: 0, cli: 0 };
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const optional = OPTIONAL_SECTION_PATTERNS.test(trimmed);
    const weight = optional ? 0.15 : 1;
    if (WEB_PATTERNS.test(trimmed)) {
      scores.web += 1 * weight;
      if (!optional) coreScores.web += 1;
    }
    if (API_PATTERNS.test(trimmed)) {
      scores.api += 1 * weight;
      if (!optional) coreScores.api += 1;
    }
    if (CLI_PATTERNS.test(trimmed)) {
      scores.cli += 1.5 * weight;
      if (!optional) coreScores.cli += 1.5;
    }
    if (CLI_STRONG_PATTERNS.test(trimmed)) {
      scores.cli += 2 * weight;
      if (!optional) coreScores.cli += 2;
    }
  }

  const strongCli = CLI_STRONG_PATTERNS.test(text);
  if (strongCli && coreScores.cli >= Math.max(coreScores.web, coreScores.api)) return "cli";
  if (coreScores.cli > 0 && coreScores.web === 0 && coreScores.api === 0) return "cli";

  const signalCount = [scores.web > 0.9, scores.api > 0.9, scores.cli > 0.9].filter(Boolean).length;
  if (signalCount > 1) {
    if (scores.cli >= (scores.web + scores.api)) return "cli";
    return "hybrid";
  }
  if (scores.web > 0.9) return "web-ui";
  if (scores.api > 0.9) return "api";
  if (scores.cli > 0.9) return "cli";
  return "unknown";
}

export function crossValidateDeliveryTarget(
  specTarget: DeliveryTarget,
  rawIdea: string,
): DeliveryTarget {
  const textTarget = detectDeliveryTargetFromText(rawIdea);

  if (textTarget !== "unknown" && specTarget !== "unknown" && textTarget !== specTarget) {
    return textTarget; // text (user intent) wins on conflict
  }
  if (specTarget === "unknown" && textTarget !== "unknown") {
    return textTarget;
  }
  return specTarget;
}
