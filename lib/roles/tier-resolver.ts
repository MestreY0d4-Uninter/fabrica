/**
 * roles/tier-resolver.ts — Provider-agnostic model tier resolution.
 *
 * Resolves a capability tier (fast/balanced/reasoning) to the best
 * available model. Uses a known-model map first, then regex fallback
 * for unknown/future models.
 */
import type { ModelTier } from "./types.js";

/** Known model → tier mappings. Checked first (exact match on full model key). */
export const KNOWN_MODEL_TIERS: Record<string, ModelTier> = {
  // OpenAI
  "openai-codex/gpt-5.3-codex-spark": "fast",
  "openai-codex/gpt-5.3-codex": "balanced",
  "openai-codex/gpt-5.4": "reasoning",
  // Anthropic
  "anthropic/claude-haiku-4-5": "fast",
  "anthropic/claude-sonnet-4-5": "balanced",
  "anthropic/claude-sonnet-4-6": "balanced",
  "anthropic/claude-opus-4-6": "reasoning",
  // Google
  "google/gemini-2.0-flash": "fast",
  "google/gemini-2.5-pro": "reasoning",
};

/** Regex fallback for unknown models (checked after KNOWN_MODEL_TIERS). */
const TIER_PATTERNS: Record<ModelTier, RegExp[]> = {
  fast: [/spark|flash|haiku|mini|nano|lite/i],
  balanced: [/sonnet|codex(?!-spark)|pro(?!-max)/i],
  reasoning: [/opus|5\.4|o[1-9]-(?!mini)/i],
};

/**
 * Resolve the best available model for a given capability tier.
 *
 * 1. Check known model map (exact match)
 * 2. Regex fallback for unknown/future models
 * 3. Returns undefined if no match — caller should use first-available fallback
 */
export function resolveModelForTier(
  tier: ModelTier,
  availableModels: Array<{ model: string; provider: string }>,
): string | undefined {
  const knownMatch = availableModels.find(
    (m) => KNOWN_MODEL_TIERS[m.model] === tier,
  );
  if (knownMatch) return knownMatch.model;

  for (const pattern of TIER_PATTERNS[tier]) {
    const match = availableModels.find((m) => pattern.test(m.model));
    if (match) return match.model;
  }
  return undefined;
}
