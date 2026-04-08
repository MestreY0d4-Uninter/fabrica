import { describe, it, expect } from "vitest";
import { DEFAULT_WORKFLOW } from "../../lib/workflow/index.js";
import { decidePostPrConvergence } from "../../lib/services/post-pr-convergence.js";

describe("post-pr convergence", () => {
  it("resets retry count when head SHA changed even if the cause stayed the same", () => {
    const result = decidePostPrConvergence({
      workflow: DEFAULT_WORKFLOW,
      feedbackQueueLabel: "To Improve",
      reason: "Cannot mark work_finish(done) with invalid QA Evidence in the PR body.\n\n- qa_gate_missing_lint",
      issueRuntime: {
        currentPrUrl: "https://example.com/pr/2",
        currentPrNumber: 2,
        currentPrHeadSha: "newsha",
        lastConvergenceCause: "invalid_qa_evidence",
        lastConvergenceRetryCount: 5,
        lastConvergenceHeadSha: "oldsha",
      },
    });

    expect(result.retryCount).toBe(1);
    expect(result.action).toBe("retry_feedback");
    expect(result.progressHeadSha).toBe("newsha");
  });
});
