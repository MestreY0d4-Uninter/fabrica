import { describe, expect, it } from "vitest";
import {
  extractReviewerDecisionFromMessages,
  parseReviewerSessionResult,
} from "../../lib/services/reviewer-session.js";

describe("reviewer-session", () => {
  it("extracts REJECT from canonical assistant output", () => {
    const result = extractReviewerDecisionFromMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "Review result: REJECT" }],
      },
    ]);

    expect(result).toBe("reject");
  });

  it("ignores markdown-wrapped and legacy heuristic decisions", () => {
    const result = extractReviewerDecisionFromMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "Review result: **REJECT**" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "LGTM" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "**APPROVED**" }],
      },
    ]);

    expect(result).toBeNull();
  });

  it("prefers the newest assistant decision", () => {
    const result = extractReviewerDecisionFromMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "Review result: APPROVE" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Review result: REJECT" }],
      },
    ]);

    expect(result).toBe("reject");
  });

  it("reads reviewer decision from runtime session messages", async () => {
    const result = await parseReviewerSessionResult(
      {
        subagent: {
          getSessionMessages: async () => ({
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Review result: APPROVE" }],
              },
            ],
          }),
        },
      },
      "agent:main:subagent:demo-reviewer-junior-ada",
    );

    expect(result).toBe("approve");
  });

  it("returns null when runtime messages do not contain the explicit decision line", async () => {
    const result = await parseReviewerSessionResult(
      {
        subagent: {
          getSessionMessages: async () => ({
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "changes requested" }],
              },
            ],
          }),
        },
      },
      "agent:main:subagent:demo-reviewer-junior-ada",
    );

    expect(result).toBeNull();
  });
});
