/**
 * Step 2: Classify idea type.
 * Tries LLM-based classification first, falls back to keyword matching.
 */
import type { PipelineStep, GenesisPayload, Classification } from "../types.js";
import { classifyByKeywords, resolveDeliveryTarget, type ClassificationRules } from "../lib/classification.js";
import { extractJsonFromStdout } from "../lib/extract-json.js";
import { resolveOpenClawCli } from "../lib/runtime-paths.js";
import { withLlmRetry } from "../lib/llm-retry.js";

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);

// Loaded lazily (JSON import)
let cachedRules: ClassificationRules | null = null;

function loadRules(): ClassificationRules {
  if (cachedRules) return cachedRules;
  cachedRules = _require("../configs/classification-rules.json") as ClassificationRules;
  return cachedRules;
}

export const classifyStep: PipelineStep = {
  name: "classify",

  shouldRun: () => true,

  async execute(payload, ctx): Promise<GenesisPayload> {
    const rules = loadRules();
    ctx.log(`Classifying idea for session ${payload.session_id}...`);

    let classification: Classification | undefined;

    // Try LLM-based classification
    try {
      const validTypes = Object.keys(rules.types).join(", ");
      const prompt = `Classify this software project idea into exactly one type.

Valid types: ${validTypes}

Idea: ${payload.raw_idea}

Return ONLY valid JSON (no markdown fences, no explanation):
{"type": "<one of: ${validTypes}>", "confidence": <0.0-1.0>, "reasoning": "<1 sentence>"}`;

      const result = await withLlmRetry(() => ctx.runCommand(resolveOpenClawCli({
        homeDir: ctx.homeDir,
        workspaceDir: ctx.workspaceDir,
      }), [
        "agent", "--local",
        "-m", prompt,
        "--session-id", `genesis-classify-${payload.session_id}`,
        "--json",
      ], { timeout: 60000 }));

      if (result.exitCode === 0 && result.stdout) {
        const parsed = extractJsonFromStdout(result.stdout);
        const text = parsed?.payloads?.[0]?.text ?? "";
        const cleaned = text.replace(/^```(json)?/gm, "").replace(/```$/gm, "").trim();
        const llmResult = JSON.parse(cleaned);

        if (llmResult.type && llmResult.type in rules.types) {
          classification = {
            type: llmResult.type,
            confidence: llmResult.confidence ?? 0.85,
            reasoning: `[LLM] ${llmResult.reasoning ?? "LLM-based classification"}`,
            alternatives: [],
            delivery_target: resolveDeliveryTarget(
              payload.metadata?.delivery_target,
              payload.raw_idea,
            ),
          };
          ctx.log(`LLM classification: ${classification.type}`);
        }
      }
    } catch (err) {
      ctx.log(`LLM classification failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Fallback: keyword/pattern matching
    if (!classification) {
      const result = classifyByKeywords(payload.raw_idea, rules);
      classification = {
        ...result,
        delivery_target: resolveDeliveryTarget(
          payload.metadata?.delivery_target,
          payload.raw_idea,
        ),
      };
    }

    ctx.log(`Result: ${classification.type} (confidence: ${classification.confidence})`);

    return {
      ...payload,
      step: "classify",
      classification,
    };
  },
};
