/**
 * Step 2: Classify idea type.
 * Tries LLM-based classification first, falls back to keyword matching.
 */
import type { PipelineStep, GenesisPayload, Classification, IdeaType } from "../types.js";
import { classifyByKeywords, resolveDeliveryTarget, type ClassificationRules } from "../lib/classification.js";
import { extractJsonFromStdout } from "../lib/extract-json.js";
import { resolveOpenClawCli } from "../lib/runtime-paths.js";
import { withLlmRetry } from "../lib/llm-retry.js";
import { z } from "zod";

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);

const LlmResponseSchema = z.object({
  payloads: z.array(z.object({ text: z.string() })).min(1),
}).passthrough();

const DirectClassificationSchema = z.object({
  type: z.enum(["feature", "bugfix", "refactor", "research", "infra"]),
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().optional(),
}).passthrough();

// Loaded lazily (JSON import)
let cachedRules: ClassificationRules | null = null;

function loadRules(): ClassificationRules {
  if (cachedRules) return cachedRules;
  cachedRules = _require("../configs/classification-rules.json") as ClassificationRules;
  return cachedRules;
}

function normalizeLlmClassification(
  raw: unknown,
  rules: ClassificationRules,
): Omit<Classification, "delivery_target"> | null {
  const isKnownType = (value: IdeaType): value is IdeaType => value in rules.types;
  const direct = DirectClassificationSchema.safeParse(raw);
  if (direct.success && isKnownType(direct.data.type)) {
    return {
      type: direct.data.type,
      confidence: direct.data.confidence ?? 0.85,
      reasoning: `[LLM] ${direct.data.reasoning ?? "LLM-based classification"}`,
      alternatives: [],
    };
  }

  const wrapped = LlmResponseSchema.safeParse(raw);
  if (!wrapped.success) {
    throw new Error(`classify: LLM output failed schema validation: ${wrapped.error.message}`);
  }
  const text = wrapped.data.payloads[0].text;
  const cleaned = text.replace(/^```(json)?/gm, "").replace(/```$/gm, "").trim();
  const parsed = JSON.parse(cleaned);
  const nested = DirectClassificationSchema.safeParse(parsed);
  if (!nested.success || !isKnownType(nested.data.type)) {
    return null;
  }
  return {
    type: nested.data.type,
    confidence: nested.data.confidence ?? 0.85,
    reasoning: `[LLM] ${nested.data.reasoning ?? "LLM-based classification"}`,
    alternatives: [],
  };
}

function isKnownGreenfieldBootstrap(payload: GenesisPayload): boolean {
  if (payload.metadata?.source !== "telegram-dm-bootstrap") return false;
  if (payload.metadata?.factory_change !== false) return false;
  if (payload.metadata?.repo_url || payload.metadata?.repo_path) return false;
  const idea = payload.raw_idea.toLowerCase();
  const projectCue = /\b(create|build|crie|criar|new project|novo projeto)\b/.test(idea);
  const softwareCue = /\b(project|projeto|cli|api|app|tool|ferramenta|library|biblioteca|bot|script)\b/.test(idea);
  return projectCue && softwareCue;
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
        const llmResult = normalizeLlmClassification(parsed, rules);
        if (llmResult) {
          classification = {
            ...llmResult,
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
      if (isKnownGreenfieldBootstrap(payload)) {
        ctx.log("LLM classification unavailable; applying greenfield bootstrap fallback to feature");
        classification = {
            type: "feature",
            confidence: 0.8,
            reasoning: "[Heuristic] Known greenfield bootstrap requests default to 'feature' when LLM classification is unavailable.",
            alternatives: [],
            delivery_target: resolveDeliveryTarget(
              payload.metadata?.delivery_target,
              payload.raw_idea,
            ),
          };
      } else {
        classification = {
            ...classifyByKeywords(payload.raw_idea, rules),
            delivery_target: resolveDeliveryTarget(
              payload.metadata?.delivery_target,
              payload.raw_idea,
            ),
          };
      }
    }

    ctx.log(`Result: ${classification.type} (confidence: ${classification.confidence})`);

    return {
      ...payload,
      step: "classify",
      classification,
    };
  },
};
