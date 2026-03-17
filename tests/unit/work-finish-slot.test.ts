import { describe, it, expect } from "vitest";
import { matchesReviewArtifact, resolveWorkerSlot } from "../../lib/tools/worker/work-finish.js";

describe("resolveWorkerSlot", () => {
  it("recovers an inactive slot by session key after breaker cleanup", () => {
    const slot = resolveWorkerSlot({
      levels: {
        senior: [
          {
            active: false,
            issueId: null,
            sessionKey: "agent:test:subagent:project-developer-senior-ada",
            startTime: null,
            previousLabel: null,
            lastIssueId: "42",
          },
        ],
      },
    }, "agent:test:subagent:project-developer-senior-ada");

    expect(slot).toEqual({
      slotIndex: 0,
      slotLevel: "senior",
      issueId: 42,
      recovered: true,
    });
  });
});

describe("matchesReviewArtifact", () => {
  it("accepts formal review artifacts for approved and changes requested states", () => {
    expect(matchesReviewArtifact({ id: 7, state: "APPROVED" }, 7, "formal_review")).toBe(true);
    expect(matchesReviewArtifact({ id: 8, state: "CHANGES_REQUESTED" }, 8, "formal_review")).toBe(true);
    expect(matchesReviewArtifact({ id: 9, state: "COMMENTED" }, 9, "formal_review")).toBe(false);
  });

  it("accepts PR conversation comments and rejects inline comments", () => {
    expect(matchesReviewArtifact({ id: 10, state: "COMMENTED" }, 10, "pr_conversation_comment")).toBe(true);
    expect(
      matchesReviewArtifact({ id: 11, state: "COMMENTED", path: "src/app.ts" }, 11, "pr_conversation_comment"),
    ).toBe(false);
  });
});
