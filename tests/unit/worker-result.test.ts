import { describe, expect, it } from "vitest";
import {
  extractWorkerResultFromMessages,
  type WorkerResult,
} from "../../lib/services/worker-result.js";

describe("worker-result", () => {
  it("extracts developer done from the final canonical line", () => {
    const result = extractWorkerResultFromMessages("developer", [
      { role: "assistant", content: [{ type: "text", text: "Work result: DONE" }] },
    ]);

    expect(result).toEqual<WorkerResult>({
      role: "developer",
      value: "DONE",
      source: "final_message",
    });
  });

  it("extracts tester fail_infra from the most recent assistant message only", () => {
    const result = extractWorkerResultFromMessages("tester", [
      { role: "assistant", content: [{ type: "text", text: "Test result: PASS" }] },
      { role: "assistant", content: [{ type: "text", text: "Test result: FAIL_INFRA" }] },
    ]);

    expect(result?.value).toBe("FAIL_INFRA");
  });

  it("returns null when the line is missing or malformed", () => {
    const result = extractWorkerResultFromMessages("architect", [
      { role: "assistant", content: [{ type: "text", text: "I finished the architecture work." }] },
    ]);

    expect(result).toBeNull();
  });
});
