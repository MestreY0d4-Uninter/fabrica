import { describe, it, expect } from "vitest";
import { resolveWorkerSlot } from "../../lib/tools/worker/work-finish.js";

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
      dispatchCycleId: null,
      dispatchRunId: null,
    });
  });
});
