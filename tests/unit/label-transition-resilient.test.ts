import { describe, it, expect, vi } from "vitest";
import { resilientLabelTransition } from "../../lib/workflow/labels.js";
import type { IssueProvider } from "../../lib/providers/provider.js";

function makeMockProvider(overrides: Partial<IssueProvider> = {}): IssueProvider {
  return {
    transitionLabel: vi.fn().mockResolvedValue(undefined),
    getIssue: vi.fn().mockResolvedValue({ labels: [], number: 1, iid: 1 }),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    listIssues: vi.fn(), createIssue: vi.fn(), closeIssue: vi.fn(),
    addLabels: vi.fn(), setLabels: vi.fn(), getPrStatus: vi.fn(),
    createPr: vi.fn(), mergePr: vi.fn(), closePr: vi.fn(),
    addComment: vi.fn(), listComments: vi.fn(),
    ...overrides,
  } as unknown as IssueProvider;
}

describe("resilientLabelTransition", () => {
  it("succeeds on first try", async () => {
    const provider = makeMockProvider();
    const result = await resilientLabelTransition(provider, 1, "To Do", "Doing");
    expect(result.success).toBe(true);
    expect(result.dualStateResolved).toBe(false);
  });

  it("recovers from dual state by removing old label", async () => {
    const provider = makeMockProvider({
      transitionLabel: vi.fn().mockRejectedValue(new Error("transition failed")),
      getIssue: vi.fn().mockResolvedValue({ labels: ["To Do", "Doing"], iid: 1 }),
      removeLabels: vi.fn().mockResolvedValue(undefined),
    });

    const result = await resilientLabelTransition(provider, 1, "To Do", "Doing");
    expect(result.success).toBe(true);
    expect(result.dualStateResolved).toBe(true);
    expect(provider.removeLabels).toHaveBeenCalledWith(1, ["To Do"]);
  });

  it("reports failure after exhausting retries", async () => {
    const provider = makeMockProvider({
      transitionLabel: vi.fn().mockRejectedValue(new Error("fail")),
      getIssue: vi.fn().mockResolvedValue({ labels: ["To Do", "Doing"], iid: 1 }),
      removeLabels: vi.fn().mockRejectedValue(new Error("also fail")),
    });

    const result = await resilientLabelTransition(provider, 1, "To Do", "Doing");
    expect(result.success).toBe(false);
    expect(provider.removeLabels).toHaveBeenCalledTimes(2);
  });
});
