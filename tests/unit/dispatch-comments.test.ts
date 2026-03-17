import { describe, it, expect } from "vitest";
import { selectIssueComments } from "../../lib/dispatch/issue-comments.js";

describe("selectIssueComments", () => {
  const comments = [
    { id: 1, author: "owner", body: "Please keep the CLI UX simple", created_at: "2026-03-12T00:00:00Z" },
    { id: 2, author: "MestreY0d4-Uninter", body: "👁️ **REVIEWER**: Rejecting due to leaked path", created_at: "2026-03-12T00:01:00Z" },
    { id: 3, author: "MestreY0d4-Uninter", body: "**Circuit breaker triggered** — 5 consecutive reviewer rejections detected.", created_at: "2026-03-12T00:02:00Z" },
  ];

  it("keeps only human issue discussion in normal developer cycles", () => {
    expect(selectIssueComments(comments, {
      role: "developer",
      hasPrContext: false,
      hasPrFeedback: false,
    })).toEqual([comments[0]]);
  });

  it("drops issue discussion entirely during feedback cycles", () => {
    expect(selectIssueComments(comments, {
      role: "developer",
      hasPrContext: false,
      hasPrFeedback: true,
    })).toEqual([]);
  });

  it("does not inject issue discussion into reviewer tasks when PR context exists", () => {
    expect(selectIssueComments(comments, {
      role: "reviewer",
      hasPrContext: true,
      hasPrFeedback: false,
    })).toEqual([]);
  });
});
