import { describe, expect, it } from "vitest";
import {
  extractWorkerResultFromMessages,
  type WorkerResult,
} from "../../lib/services/worker-result.js";

describe("worker-result", () => {
  it("extracts developer done from the final canonical line", () => {
    const result = extractWorkerResultFromMessages("developer", [
      {
        role: "assistant",
        content: [{ type: "text", text: "Work result: BLOCKED\nWork result: DONE" }],
      },
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

  it("extracts tester blocked as an allowed result", () => {
    const result = extractWorkerResultFromMessages("tester", [
      { role: "assistant", content: [{ type: "text", text: "Test result: BLOCKED" }] },
    ]);

    expect(result).toEqual({
      role: "tester",
      value: "BLOCKED",
      source: "final_message",
    });
  });

  it("returns null for architect approve or reject results", () => {
    const approveResult = extractWorkerResultFromMessages("architect", [
      { role: "assistant", content: [{ type: "text", text: "Architecture result: APPROVE" }] },
    ]);
    const rejectResult = extractWorkerResultFromMessages("architect", [
      { role: "assistant", content: [{ type: "text", text: "Architecture result: REJECT" }] },
    ]);

    expect(approveResult).toBeNull();
    expect(rejectResult).toBeNull();
  });

  it("returns null when the newest assistant message is empty even if an older one is valid", () => {
    const result = extractWorkerResultFromMessages("developer", [
      { role: "assistant", content: [{ type: "text", text: "Work result: DONE" }] },
      { role: "assistant", content: [] },
    ]);

    expect(result).toBeNull();
  });

  it("returns null when the line is missing or malformed", () => {
    const missingResult = extractWorkerResultFromMessages("architect", [
      { role: "assistant", content: [{ type: "text", text: "I finished the architecture work." }] },
    ]);
    const malformedResult = extractWorkerResultFromMessages("architect", [
      { role: "assistant", content: [{ type: "text", text: "Architecture result: MAYBE" }] },
    ]);

    expect(missingResult).toBeNull();
    expect(malformedResult).toBeNull();
  });
});
