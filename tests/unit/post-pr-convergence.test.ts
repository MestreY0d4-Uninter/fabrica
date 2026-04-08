import { describe, it, expect } from "vitest";
import { DEFAULT_WORKFLOW } from "../../lib/workflow/index.js";
import { decidePostPrConvergence } from "../../lib/services/post-pr-convergence.js";

describe("post-pr convergence", () => {
  it("treats qa_stale_or_unchanged as a stricter subcause with low retry budget", () => {
    const result = decidePostPrConvergence({
      workflow: DEFAULT_WORKFLOW,
      feedbackQueueLabel: "To Improve",
      reason: "qa_stale_or_unchanged\n\nCannot mark work_finish(done) with invalid QA Evidence in the PR body.\n\n- qa_gate_missing_lint",
      issueRuntime: {
        currentPrUrl: "https://example.com/pr/2",
        currentPrNumber: 2,
        currentPrHeadSha: "same-sha",
        lastConvergenceCause: "qa_stale_or_unchanged",
        lastConvergenceRetryCount: 1,
        lastConvergenceHeadSha: "same-sha",
      },
    });

    expect(result.cause).toBe("qa_stale_or_unchanged");
    expect(result.retryCount).toBe(2);
    expect(result.action).toBe("escalate_human");
    expect(result.targetLabel).toBe("Refining");
  });

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
