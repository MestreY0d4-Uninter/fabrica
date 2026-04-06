import { describe, expect, it } from "vitest";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";
import { conductInterviewStep } from "../../lib/intake/steps/conduct-interview.js";

function makePayload(rawIdea: string): GenesisPayload {
  return {
    session_id: "sid-conduct-interview",
    timestamp: new Date().toISOString(),
    step: "interview",
    raw_idea: rawIdea,
    answers: {},
    metadata: {
      source: "test",
      factory_change: false,
    },
    classification: {
      type: "feature",
      confidence: 0.9,
      reasoning: "feature",
      delivery_target: "api",
    },
    interview: {
      questions: [
        { id: "f1", question: "What are the primary workflows?", required: true },
      ],
    },
  } as GenesisPayload;
}

describe("conductInterviewStep fallback behavior", () => {
  it("derives richer fallback scope and acceptance criteria for broad operational prompts", async () => {
    const payload = makePayload(
      "Build an incident management platform with alerts, notifications, role-based access, admin view, audit history, and a background process for escalations.",
    );

    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => {
        const err = new Error("LLM unavailable") as Error & { statusCode?: number };
        err.statusCode = 400;
        throw err;
      },
    };

    const result = await conductInterviewStep.execute(payload, ctx);
    expect(result.spec_data?.scope_v1.length).toBeGreaterThanOrEqual(3);
    expect(result.spec_data?.acceptance_criteria.length).toBeGreaterThanOrEqual(3);
    expect(result.spec_data?.scope_v1.join(" ").toLowerCase()).toMatch(/auth|background|admin|audit|notification/);
  });
});
