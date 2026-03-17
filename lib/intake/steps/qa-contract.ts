/**
 * Step 9: QA Contract — generate stack-aware quality gates from spec.
 */
import type { PipelineStep, GenesisPayload } from "../types.js";
import { generateQaContract } from "../../quality/qa-contracts.js";
import { normalizeStackHint, detectStackFromText, detectStackFromDeliveryTarget } from "../lib/stack-detection.js";

export const qaContractStep: PipelineStep = {
  name: "qa-contract",

  shouldRun: (payload) => !!payload.spec,

  async execute(payload, ctx): Promise<GenesisPayload> {
    const spec = payload.spec!;

    // Resolve stack: scaffold.stack > metadata.stack_hint > spec text detection > delivery target default
    let stack = payload.scaffold?.stack
      ? normalizeStackHint(payload.scaffold.stack) || payload.scaffold.stack
      : "";

    if (!stack && payload.metadata.stack_hint) {
      stack = normalizeStackHint(payload.metadata.stack_hint) || "";
    }

    if (!stack) {
      stack = detectStackFromText(`${spec.title} ${spec.objective} ${spec.scope_v1.join(" ")}`);
    }

    if (!stack) {
      stack = detectStackFromDeliveryTarget(spec.delivery_target);
    }

    ctx.log(`QA contract: stack=${stack}, delivery_target=${spec.delivery_target}`);

    const qaContract = generateQaContract({
      spec,
      stack: stack as any,
      acceptanceCriteria: spec.acceptance_criteria,
    });

    ctx.log(`QA contract: ${qaContract.gates.length} gates, ${qaContract.acceptance_tests.length} acceptance tests`);

    return {
      ...payload,
      step: "qa-contract",
      qa_contract: qaContract,
    };
  },
};
