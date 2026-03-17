/**
 * Step 10: Security Review — pattern-based spec security analysis.
 */
import type { PipelineStep, GenesisPayload } from "../types.js";
import { reviewSpecSecurity } from "../../quality/security-audit.js";

export const securityReviewStep: PipelineStep = {
  name: "security-review",

  shouldRun: (payload) => !!payload.spec,

  async execute(payload, ctx): Promise<GenesisPayload> {
    const spec = payload.spec!;

    ctx.log(`Running security review for session ${payload.session_id}`);

    // Spec-level security review (pattern matching + auth gate validation)
    let review = reviewSpecSecurity({
      spec,
      rawIdea: payload.raw_idea,
      authGate: payload.metadata?.auth_gate,
    });

    ctx.log(`Security notes: ${review.spec_security_notes.length}, recommendation: ${review.recommendation}`);

    return {
      ...payload,
      step: "security-review",
      security: review,
    };
  },
};
