import type { GenesisPayload, PipelineStep } from "../types.js";
import { buildResearch } from "../lib/research.js";

export const researchStep: PipelineStep = {
  name: "research",

  shouldRun: (payload) => !!payload.classification,

  async execute(payload, ctx): Promise<GenesisPayload> {
    const { research, stackHint, stackConfidence } = buildResearch(
      payload.raw_idea,
      payload.classification,
      payload.metadata,
    );

    ctx.log(
      `Research synthesized: status=${research.status ?? "ok"}, technologies=${research.technologies.length}, references=${research.references.length}`,
    );

    return {
      ...payload,
      step: "research",
      research,
      metadata: {
        ...payload.metadata,
        stack_hint: payload.metadata.stack_hint ?? stackHint,
        stack_confidence: payload.metadata.stack_confidence ?? stackConfidence,
        research_summary: research.summary ?? payload.metadata.research_summary ?? null,
      },
    };
  },
};
