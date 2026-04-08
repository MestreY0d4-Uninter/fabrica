import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockReadProjects, mockCreateProvider } = vi.hoisted(() => ({
  mockReadProjects: vi.fn(),
  mockCreateProvider: vi.fn(),
}));

vi.mock("../../lib/projects/index.js", () => ({
  readProjects: mockReadProjects,
  getIssueRuntime: (project: any, issueId: number) => project.issueRuntime?.[String(issueId)],
}));

vi.mock("../../lib/providers/index.js", () => ({
  createProvider: mockCreateProvider,
}));

describe("runIssueDoctor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProjects.mockResolvedValue({
      projects: {
        demo: {
          slug: "demo",
          name: "Demo",
          repo: "org/repo",
          provider: "github",
          providerProfile: null,
          workers: {},
          issueRuntime: {
            "7": {
              currentPrNumber: 2,
              currentPrUrl: "https://example.com/pr/2",
              currentPrState: "open",
              lastConvergenceCause: "invalid_qa_evidence",
              lastConvergenceAction: "retry_feedback",
              lastConvergenceRetryCount: 3,
              lastConvergenceReason: "qa_gate_missing_lint",
              lastConvergenceAt: "2026-04-08T00:00:00.000Z",
            },
          },
        },
      },
    });
    mockCreateProvider.mockResolvedValue({
      provider: {
        getPrStatus: vi.fn().mockResolvedValue({
          url: "https://example.com/pr/2",
          state: "open",
          number: 2,
          mergeable: false,
          currentIssueMatch: true,
          sourceBranch: "feature/7-demo",
        }),
        getIssue: vi.fn().mockResolvedValue({
          web_url: "https://example.com/issues/7",
          state: "OPEN",
          labels: ["To Improve", "review:agent"],
          title: "Demo issue",
        }),
      },
    });
  });

  it("returns convergence-aware issue/run diagnostics", async () => {
    const { runIssueDoctor } = await import("../../lib/setup/doctor-run.js");
    const result = await runIssueDoctor({
      workspacePath: "/tmp/ws",
      projectSlug: "demo",
      issueId: 7,
      runCommand: vi.fn(),
      pluginConfig: {},
    });

    expect(result.hasArtifact).toBe(true);
    expect(result.convergence.cause).toBe("invalid_qa_evidence");
    expect(result.pr?.url).toBe("https://example.com/pr/2");
    expect(result.lifecycle.progressState).toBe("no_dispatch");
    expect(result.convergence.headShaChangedSinceLastConvergence).toBe(null);
    expect(result.recommendation.likelyNextAction).toBe("repair_qa_evidence");
  });
});
