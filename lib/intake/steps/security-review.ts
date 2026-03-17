/**
 * Step 10: Security Review — pattern-based spec security analysis.
 */
import type { PipelineStep, GenesisPayload } from "../types.js";
import { reviewSpecSecurity } from "../../quality/security-audit.js";

/** Returns true if the issue requires human security review before auto-dispatch. */
export function needsHumanSecurity(securityScore: number, authSignalPresent: boolean): boolean {
  return securityScore < 40 && authSignalPresent;
}

const AUTH_REGEX = /\b(?:auth|oauth|jwt|token|password|credential|session|permission|role|acl)\b/i;

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

    const authSignal = AUTH_REGEX.test((payload.raw_idea ?? "") + " " + (spec.objective ?? ""));
    const securityScore = review.score ?? (review.spec_security_notes.length === 0 ? 100 : Math.max(0, 100 - review.spec_security_notes.length * 20));
    let updatedMetadata = payload.metadata;
    if (needsHumanSecurity(securityScore, authSignal)) {
      updatedMetadata = { ...updatedMetadata, needs_human_security: true };
    }

    return {
      ...payload,
      step: "security-review",
      security: review,
      metadata: updatedMetadata,
    };
  },
};
