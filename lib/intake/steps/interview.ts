/**
 * Step 3: Generate interview questions based on idea type.
 */
import type { PipelineStep, GenesisPayload, InterviewQuestion } from "../types.js";

type TemplateQuestion = {
  id: string;
  question: string;
  required: boolean;
  follow_up_if_vague?: string | null;
};

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);

type InterviewTemplates = {
  version: string;
  max_rounds: number;
  types: Record<string, {
    round1: TemplateQuestion[];
  }>;
};

let cachedTemplates: InterviewTemplates | null = null;

function loadTemplates(): InterviewTemplates {
  if (cachedTemplates) return cachedTemplates;
  cachedTemplates = _require("../configs/interview-templates.json") as InterviewTemplates;
  return cachedTemplates;
}

export const interviewStep: PipelineStep = {
  name: "interview",

  shouldRun: () => true,

  async execute(payload, ctx): Promise<GenesisPayload> {
    const templates = loadTemplates();
    const type = payload.classification?.type ?? "feature";
    const typeTemplates = templates.types[type] ?? templates.types.feature;

    ctx.log(`Generating interview questions for type=${type}`);

    // Select a stable baseline of round-1 questions.
    const questions: InterviewQuestion[] = typeTemplates.round1
      .slice(0, 4)
      .map(q => ({
        id: q.id,
        question: q.question,
        required: q.required,
        follow_up_if_vague: q.follow_up_if_vague,
      }));

    return {
      ...payload,
      step: "interview",
      interview: {
        questions,
        guidelines: `Interview for ${type} idea. Use clear language, preserve the user's technical terms, and only explain jargon when asked.`,
      },
    };
  },
};
