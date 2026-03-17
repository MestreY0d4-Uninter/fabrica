/**
 * Step 4a: Conduct interview — LLM answers questions to produce spec_data.
 */
import type { PipelineStep, GenesisPayload, SpecData } from "../types.js";
import { extractJsonFromStdout } from "../lib/extract-json.js";
import { resolveOpenClawCli } from "../lib/runtime-paths.js";

/** Type-aware deterministic defaults when LLM fails. */
function fallbackSpecData(type: string, rawIdea: string): SpecData {
  const title = rawIdea.slice(0, 120);
  const base: SpecData = {
    title,
    objective: rawIdea,
    scope_v1: [rawIdea],
    out_of_scope: ["To be defined during implementation"],
    acceptance_criteria: [],
    definition_of_done: ["Code reviewed and merged", "Tests pass", "QA contract passes"],
    constraints: "None specified",
    risks: [],
  };

  switch (type) {
    case "bugfix":
      base.acceptance_criteria = ["The reported bug no longer occurs", "Regression test added"];
      break;
    case "refactor":
      base.acceptance_criteria = ["Code refactored as described", "All existing tests still pass"];
      break;
    case "research":
      base.acceptance_criteria = ["Research document produced with findings"];
      base.definition_of_done = ["Document reviewed"];
      break;
    case "infra":
      base.acceptance_criteria = ["Infrastructure change applied and verified"];
      break;
    default: // feature
      base.acceptance_criteria = ["Feature works as described in the objective"];
  }

  return base;
}

export const conductInterviewStep: PipelineStep = {
  name: "conduct-interview",

  shouldRun: (payload) => !!payload.interview,

  async execute(payload, ctx): Promise<GenesisPayload> {
    const type = payload.classification?.type ?? "feature";
    ctx.log(`Conducting interview for type=${type}`);

    // Try LLM to answer interview questions
    try {
      const questionsText = (payload.interview?.questions ?? [])
        .map((q, i) => `${i + 1}. ${q.question}`)
        .join("\n");
      const answersText = Object.entries(payload.answers ?? {})
        .map(([key, value]) => `- ${key}: ${value}`)
        .join("\n");

      const prompt = `You are a software specification expert. Based on this project idea, answer the interview questions to produce a structured specification.

Idea: ${payload.raw_idea}
Classification: ${type}

Questions:
${questionsText}

Existing answers:
${answersText || "(none provided yet)"}

Return ONLY valid JSON (no markdown fences):
{
  "title": "<concise project title, max 120 chars>",
  "objective": "<clear objective statement>",
  "scope_v1": ["<scope item 1>", "<scope item 2>"],
  "out_of_scope": ["<item>"],
  "acceptance_criteria": ["<specific, domain-aware AC 1>", "<AC 2>"],
  "definition_of_done": ["Code reviewed and merged", "Tests pass", "QA contract passes"],
  "constraints": "<constraints or 'None specified'>",
  "risks": ["<risk 1>"]
}

IMPORTANT: Acceptance criteria must be domain-specific, not generic.`;

      const result = await ctx.runCommand(resolveOpenClawCli({
        homeDir: ctx.homeDir,
        workspaceDir: ctx.workspaceDir,
      }), [
        "agent", "--local",
        "-m", prompt,
        "--session-id", `genesis-interview-${payload.session_id}`,
        "--json",
      ], { timeout: 90000 });

      if (result.exitCode === 0 && result.stdout) {
        const parsed = extractJsonFromStdout(result.stdout);
        const text = parsed?.payloads?.[0]?.text ?? "";
        const cleaned = text.replace(/^```(json)?/gm, "").replace(/```$/gm, "").trim();
        const specData = JSON.parse(cleaned) as SpecData;

        if (specData.title && specData.objective) {
          ctx.log(`LLM spec generated: "${specData.title}"`);
          return {
            ...payload,
            step: "conduct-interview",
            spec_data: specData,
          };
        }
      }
    } catch (err) {
      ctx.log(`LLM interview failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Fallback: type-aware deterministic defaults
    return {
      ...payload,
      step: "conduct-interview",
      spec_data: fallbackSpecData(type, payload.raw_idea),
    };
  },
};
