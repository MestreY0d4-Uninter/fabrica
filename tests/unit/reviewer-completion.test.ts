import { describe, expect, it } from "vitest";
import { DEFAULT_WORKFLOW } from "../../lib/workflow/index.js";
import {
  handleReviewerAgentEnd,
  resolveReviewerDecisionTransition,
} from "../../lib/services/reviewer-completion.js";

describe("reviewer-completion", () => {
  it("maps approve to the reviewing APPROVE transition", () => {
    const result = resolveReviewerDecisionTransition(DEFAULT_WORKFLOW, "approve");

    expect(result?.eventKey).toBe("APPROVE");
    expect(result?.targetLabel).toBe("To Test");
  });

  it("maps reject to the reviewing REJECT transition", () => {
    const result = resolveReviewerDecisionTransition(DEFAULT_WORKFLOW, "reject");

    expect(result?.eventKey).toBe("REJECT");
    expect(result?.targetLabel).toBe("To Improve");
  });

  it("extracts reviewer decision from explicit agent_end messages only", async () => {
    const result = await handleReviewerAgentEnd({
      sessionKey: "agent:main:subagent:demo-reviewer-junior-ada",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Review result: APPROVE" }],
        },
      ],
    });

    expect(result).toBe("approve");
  });

  it("does not infer reviewer decisions from legacy shorthand", async () => {
    const result = await handleReviewerAgentEnd({
      sessionKey: "agent:main:subagent:demo-reviewer-junior-ada",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "LGTM" }],
        },
      ],
    });

    expect(result).toBeNull();
  });

  it("falls back to runtime session messages when agent_end messages are undecidable", async () => {
    const result = await handleReviewerAgentEnd({
      sessionKey: "agent:main:subagent:demo-reviewer-junior-ada",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Review complete." }],
        },
      ],
      runtime: {
        subagent: {
          getSessionMessages: async () => ({
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Review result: REJECT" }],
              },
            ],
          }),
        },
      },
    });

    expect(result).toBe("reject");
  });
});
