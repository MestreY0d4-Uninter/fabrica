import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IssueProvider } from "../../lib/providers/provider.js";

// Mock the internal pass functions to isolate the wrappers
vi.mock("../../lib/services/heartbeat/review.js", () => ({
  reviewPass: vi.fn().mockResolvedValue(0),
}));
vi.mock("../../lib/services/heartbeat/review-skip.js", () => ({
  reviewSkipPass: vi.fn().mockResolvedValue(0),
}));
vi.mock("../../lib/services/heartbeat/test-skip.js", () => ({
  testSkipPass: vi.fn().mockResolvedValue(0),
}));
vi.mock("../../lib/services/heartbeat/hold-escape.js", () => ({
  holdEscapePass: vi.fn().mockResolvedValue(0),
}));

import {
  performReviewPass,
  performReviewSkipPass,
  performTestSkipPass,
  performHoldEscapePass,
} from "../../lib/services/heartbeat/passes.js";
import { reviewPass } from "../../lib/services/heartbeat/review.js";
import { reviewSkipPass } from "../../lib/services/heartbeat/review-skip.js";
import { testSkipPass } from "../../lib/services/heartbeat/test-skip.js";
import { holdEscapePass } from "../../lib/services/heartbeat/hold-escape.js";

// Minimal mock objects
const mockProvider = {} as IssueProvider;
const mockRunCommand = vi.fn();
const mockProject = {
  name: "test-project",
  slug: "test-project",
  repo: "org/test-project",
  channels: [],
  baseBranch: "main",
} as any;
const mockResolvedConfig = {
  workflow: { states: {} },
  timeouts: { gitPullMs: 30000 },
} as any;

describe("performReviewPass", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("delegates to reviewPass and returns its result", async () => {
    (reviewPass as any).mockResolvedValue(2);
    const result = await performReviewPass(
      "/tmp/ws", "test-project", mockProject, mockProvider,
      mockResolvedConfig, undefined, undefined, mockRunCommand,
    );
    expect(result).toBe(2);
    expect(reviewPass).toHaveBeenCalledOnce();
  });

  it("returns 0 when reviewPass returns 0", async () => {
    (reviewPass as any).mockResolvedValue(0);
    const result = await performReviewPass(
      "/tmp/ws", "test-project", mockProject, mockProvider,
      mockResolvedConfig, undefined, undefined, mockRunCommand,
    );
    expect(result).toBe(0);
  });
});

describe("performReviewSkipPass", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("delegates to reviewSkipPass and returns its result", async () => {
    (reviewSkipPass as any).mockResolvedValue(1);
    const result = await performReviewSkipPass(
      "/tmp/ws", "test-project", mockProject, mockProvider,
      mockResolvedConfig, undefined, undefined, mockRunCommand,
    );
    expect(result).toBe(1);
    expect(reviewSkipPass).toHaveBeenCalledOnce();
  });
});

describe("performTestSkipPass", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("delegates to testSkipPass and returns its result", async () => {
    (testSkipPass as any).mockResolvedValue(3);
    const result = await performTestSkipPass(
      "/tmp/ws", "test-project", mockProject, mockProvider,
      mockResolvedConfig, mockRunCommand,
    );
    expect(result).toBe(3);
    expect(testSkipPass).toHaveBeenCalledOnce();
  });
});

describe("performHoldEscapePass", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("delegates to holdEscapePass and returns its result", async () => {
    (holdEscapePass as any).mockResolvedValue(1);
    const result = await performHoldEscapePass(
      "/tmp/ws", "test-project", mockProject, mockProvider,
      mockResolvedConfig, undefined, undefined, mockRunCommand,
    );
    expect(result).toBe(1);
    expect(holdEscapePass).toHaveBeenCalledOnce();
  });
});
