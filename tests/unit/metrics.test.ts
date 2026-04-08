import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockReadFile, mockReadProjects } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockReadProjects: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
}));

vi.mock("../../lib/projects/index.js", () => ({
  readProjects: mockReadProjects,
}));

describe("computeMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProjects.mockResolvedValue({
      projects: {
        demo: { stack: "python-cli", environment: null },
      },
    });
    mockReadFile.mockImplementation(async (path: string) => {
      if (!String(path).endsWith("audit.log")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return [
        JSON.stringify({ ts: "2026-04-08T10:00:00.000Z", event: "dispatch", projectSlug: "demo", issueId: 7 }),
        JSON.stringify({ ts: "2026-04-08T10:10:00.000Z", event: "pr_discovered_via_polling", projectSlug: "demo", issueId: 7 }),
        JSON.stringify({ ts: "2026-04-08T10:12:00.000Z", event: "doctor_snapshot", projectSlug: "demo", issueId: 7, convergenceCause: "invalid_qa_evidence", convergenceAction: "escalate_human" }),
        JSON.stringify({ ts: "2026-04-08T10:20:00.000Z", event: "work_finish", projectSlug: "demo", issueId: 7, result: "done" }),
      ].join("\n");
    });
  });

  it("aggregates cause and stack metrics", async () => {
    const { computeMetrics } = await import("../../lib/observability/metrics.js");
    const result = await computeMetrics("/tmp/ws");
    expect(result.avgDispatchToFirstPrMinutes).toBe(10);
    expect(result.avgDispatchToCompletionMinutes).toBe(20);
    expect(result.humanEscalations).toBe(1);
    expect(result.causeCounts.invalid_qa_evidence).toBe(1);
    expect(result.stackMetrics["python-cli"]?.avgDispatchToFirstPrMinutes).toBe(10);
  });
});
