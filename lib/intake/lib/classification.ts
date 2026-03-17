/**
 * Idea classification via keyword/pattern matching.
 * Port of the fallback path from classify-idea.sh.
 * LLM-based classification is handled by the step itself.
 */
import type { IdeaType, Classification, DeliveryTarget } from "../types.js";
import { detectDeliveryTargetFromText, normalizeDeliveryTarget } from "./delivery-target.js";

export type ClassificationRule = {
  keywords: string[];
  patterns: string[];
  weight: number;
};

export type ClassificationRules = {
  version: string;
  default_type: IdeaType;
  confidence_threshold: number;
  types: Record<string, ClassificationRule>;
};

/**
 * Classify an idea using keyword/pattern matching (fallback when LLM is unavailable).
 */
export function classifyByKeywords(
  rawIdea: string,
  rules: ClassificationRules,
): Omit<Classification, "delivery_target"> {
  const ideaLower = rawIdea.toLowerCase();
  let bestType: IdeaType = rules.default_type as IdeaType;
  let bestScore = 0;

  const results: Array<{ type: string; raw_score: number }> = [];

  for (const [type, rule] of Object.entries(rules.types)) {
    let score = 0;

    // Keyword matching
    for (const kw of rule.keywords) {
      if (ideaLower.includes(kw)) score++;
    }

    // Pattern matching
    for (const pat of rule.patterns) {
      try {
        if (new RegExp(pat, "i").test(rawIdea)) score += 2;
      } catch { /* invalid regex */ }
    }

    const weighted = score * rule.weight;
    results.push({ type, raw_score: score });

    if (weighted > bestScore || (score > 0 && bestScore === 0)) {
      bestScore = weighted;
      bestType = type as IdeaType;
    }
  }

  const confidence = bestScore > 0
    ? Math.round((bestScore / (bestScore + 2)) * 100) / 100
    : 0.30;

  const alternatives = results
    .filter(r => r.type !== bestType && r.raw_score > 0)
    .map(r => ({
      type: r.type as IdeaType,
      confidence: Math.round((r.raw_score / (r.raw_score + 3)) * 100) / 100,
    }));

  const reasoning = bestScore > 0
    ? `[Keywords] Classified as '${bestType}' based on ${bestScore} keyword/pattern matches.`
    : `[Keywords] No strong signals found. Defaulting to '${rules.default_type}'.`;

  return { type: bestType, confidence, alternatives, reasoning };
}

/**
 * Resolve delivery target from metadata or text detection.
 */
export function resolveDeliveryTarget(
  rawTarget: string | undefined | null,
  rawIdea: string,
): DeliveryTarget {
  if (!rawTarget || rawTarget === "null") {
    return detectDeliveryTargetFromText(rawIdea);
  }
  return normalizeDeliveryTarget(rawTarget);
}
