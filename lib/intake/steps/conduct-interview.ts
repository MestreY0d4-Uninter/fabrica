/**
 * Step 4a: Conduct interview — LLM answers questions to produce spec_data.
 */
import type { PipelineStep, GenesisPayload, SpecData } from "../types.js";
import { extractJsonFromStdout } from "../lib/extract-json.js";
import { resolveOpenClawCli } from "../lib/runtime-paths.js";
import { withLlmRetry } from "../lib/llm-retry.js";
import { z } from "zod";

const LlmResponseSchema = z.object({
  payloads: z.array(z.object({ text: z.string() })).min(1),
}).passthrough();

/** Type-aware deterministic defaults when LLM fails. */
function deriveFeatureScopeFromRawIdea(rawIdea: string): string[] {
  const text = rawIdea.toLowerCase();
  const scope: string[] = [];
  const add = (item: string) => {
    if (!scope.includes(item)) scope.push(item);
  };

  if (/\b(auth|oauth|jwt|login|register|session|role-based access|rbac|permissions?)\b/i.test(text)) {
    add("Implement authentication, authorization, and role-aware access rules");
  }
  if (/\b(incident|project|task|owner|assign|timeline|status|update)s?\b/i.test(text)) {
    add("Implement the core domain workflows and CRUD endpoints for the main entities");
  }
  if (/\b(alert|alerts|notif|notification|notifications|reminder|reminders|escalation|escalations)\b/i.test(text)) {
    add("Implement notifications, reminders, and escalation flows for key events");
  }
  if (/\b(background process|background worker|worker|queue|job|celery|bull|sidekiq|scheduler)\b/i.test(text)) {
    add("Implement the background processing pipeline required for asynchronous work");
  }
  if (/\b(admin view|admin panel|admin console|dashboard|audit history|audit log|activity history)\b/i.test(text)) {
    add("Implement administrative visibility and audit/history capabilities for operators");
  }

  if (scope.length < 3) {
    add("Implement the primary user workflow described in the request");
    add("Expose the key interactions needed to operate the system end to end");
    add("Add validation and persistence rules for the main business flow");
  }

  return scope.slice(0, 5);
}

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
      base.scope_v1 = deriveFeatureScopeFromRawIdea(rawIdea);
      base.acceptance_criteria = [
        "Allows operators to complete the primary workflow end to end as requested",
        "Validates and enforces the role, permission, or delivery constraints described in the request",
        "Processes the asynchronous or background behavior required for the main operational path",
      ];
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

      const prompt = `You are a pragmatic senior engineer scoping a small project from a brief user request. Your job is to derive a tight, actionable specification — NOT to ask more questions.

User request: "${payload.raw_idea}"
Type: ${type}

Context from earlier steps:
${answersText || "(none)"}

Produce a concise JSON spec. The title should be a SHORT name (3-5 words, suitable as a repo name). Keep scope minimal — only what the user explicitly asked for.

Return ONLY valid JSON (no markdown fences):
{
  "project_slug": "<kebab-case repo name, 2-4 words, e.g. email-validator-cli>",
  "title": "<short project name, 3-5 words, max 60 chars>",
  "objective": "<1-2 sentence objective>",
  "scope_v1": ["<concrete deliverable 1>", "<concrete deliverable 2>"],
  "out_of_scope": ["<item>"],
  "acceptance_criteria": ["<specific, testable AC 1>", "<AC 2>"],
  "definition_of_done": ["Code reviewed and merged", "Tests pass", "QA contract passes"],
  "constraints": "<constraints or 'None specified'>",
  "risks": ["<risk 1>"]
}

Rules:
- Title must be a short name like "email-validator-cli" or "task-tracker-api", NOT a full sentence.
- Acceptance criteria must be domain-specific and testable.
- Do NOT invent features the user didn't ask for.
- Keep it lean — a CLI that validates emails doesn't need auth, profiles, or config files.`;

      const result = await withLlmRetry(() => ctx.runCommand(resolveOpenClawCli({
        homeDir: ctx.homeDir,
        workspaceDir: ctx.workspaceDir,
      }), [
        "agent", "--local",
        "-m", prompt,
        "--session-id", `genesis-interview-${payload.session_id}`,
        "--json",
      ], { timeout: 90000 }));

      if (result.exitCode === 0 && result.stdout) {
        const parsed = extractJsonFromStdout(result.stdout);
        const validated = LlmResponseSchema.safeParse(parsed);
        if (!validated.success) {
          throw new Error(`conduct-interview: LLM output failed schema validation: ${validated.error.message}`);
        }
        const text = validated.data.payloads[0].text;
        const cleaned = text.replace(/^```(json)?/gm, "").replace(/```$/gm, "").trim();
        const specData = JSON.parse(cleaned) as SpecData;

        if (specData.title && specData.objective) {
          ctx.log(`LLM spec generated: "${specData.title}"`);

          // Vague scope detection — flag for follow-up if scope is thin
          const scopeCount = Array.isArray(specData.scope_v1) ? specData.scope_v1.length : 0;
          const objectiveWordCount = (specData.objective ?? "").trim().split(/\s+/).length;
          if (scopeCount < 3 || objectiveWordCount < 20) {
            ctx.log(`Spec scope appears vague — flagging for follow-up`);
            return {
              ...payload,
              step: "conduct-interview",
              spec_data: specData,
              metadata: { ...payload.metadata, needs_spec_refinement: true },
            };
          }

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
