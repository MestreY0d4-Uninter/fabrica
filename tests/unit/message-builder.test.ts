import { describe, expect, it } from "vitest";
import { buildTaskMessage, formatSessionLabel, formatSessionLabelFull } from "../../lib/dispatch/message-builder.js";

describe("formatSessionLabel", () => {
  it("keeps gateway session labels within the 64 character limit", () => {
    const label = formatSessionLabel(
      "stack-cli-para-ambientes-de-desenvolvimento-reproduziveis-com-nix-flakes",
      "developer",
      "senior",
      "Adrianne",
    );

    expect(label.length).toBeLessThanOrEqual(64);
    expect(label).toContain("Developer");
  });

  it("preserves the full human-readable label separately", () => {
    const fullLabel = formatSessionLabelFull(
      "stack-cli-para-ambientes-de-desenvolvimento-reproduziveis-com-nix-flakes",
      "developer",
      "senior",
      "Adrianne",
    );
    const shortLabel = formatSessionLabel(
      "stack-cli-para-ambientes-de-desenvolvimento-reproduziveis-com-nix-flakes",
      "developer",
      "senior",
      "Adrianne",
    );

    expect(fullLabel.length).toBeGreaterThan(64);
    expect(shortLabel.length).toBeLessThanOrEqual(64);
    expect(fullLabel).toContain("Developer Adrianne");
    expect(shortLabel).toContain("...");
  });
});

describe("buildTaskMessage", () => {
  it("embeds the resolved security checklist in the task envelope", () => {
    const message = buildTaskMessage({
      projectName: "demo",
      channelId: "demo",
      role: "reviewer",
      issueId: 1,
      issueTitle: "Review this",
      issueDescription: "Issue body",
      issueUrl: "https://example.com/issues/1",
      repo: "https://github.com/org/repo",
      baseBranch: "main",
      securityChecklist: "- Check for leaked secrets\n- Check auth flows",
    });

    expect(message).toContain("## Security Checklist");
    expect(message).toContain("Check for leaked secrets");
  });

  it("does not append work_finish instructions to reviewer task messages", () => {
    const message = buildTaskMessage({
      projectName: "demo",
      channelId: "demo",
      role: "reviewer",
      issueId: 1,
      issueTitle: "Review this",
      issueDescription: "Issue body",
      issueUrl: "https://example.com/issues/1",
      repo: "https://github.com/org/repo",
      baseBranch: "main",
    });

    expect(message).toContain("Review result: APPROVE");
    expect(message).toContain("Review result: REJECT");
    expect(message).not.toContain("work_finish");
  });

  it("adds canonical developer result lines instead of mandatory work_finish instructions", () => {
    const message = buildTaskMessage({
      projectName: "demo",
      channelId: "demo",
      role: "developer",
      issueId: 7,
      issueTitle: "Implement the feature",
      issueDescription: "Ship the CLI command",
      issueUrl: "https://example.com/issues/7",
      repo: "https://github.com/org/repo",
      baseBranch: "main",
    });

    expect(message).toContain("Work result: DONE");
    expect(message).toContain("Work result: BLOCKED");
    expect(message).not.toContain("MUST invoke the `work_finish`");
  });

  it("includes the canonical execution path and required worktree for local repositories", () => {
    const message = buildTaskMessage({
      projectName: "demo",
      channelId: "demo",
      role: "developer",
      issueId: 9,
      issueTitle: "Implement locally",
      issueDescription: "Use the registered repo path",
      issueUrl: "https://example.com/issues/9",
      repo: "/home/ubuntu/git/acme/demo",
      baseBranch: "main",
    });

    expect(message).toContain("Repo: /home/ubuntu/git/acme/demo | Base branch: main");
    expect(message).toContain("Execution path: /home/ubuntu/git/acme/demo");
    expect(message).toContain("Required branch: feature/9-demo");
    expect(message).toContain("Required worktree: /home/ubuntu/git/acme/demo.worktrees/feature/9-demo");
    expect(message).toContain("Do not re-initialize or replace the scaffold in the main checkout");
    expect(message).not.toContain("repository workspace hidden");
  });

  it("reuses the PR branch instructions during feedback cycles", () => {
    const message = buildTaskMessage({
      projectName: "demo app",
      channelId: "demo",
      role: "developer",
      issueId: 42,
      issueTitle: "Address review",
      issueDescription: "Fix reviewer feedback",
      issueUrl: "https://example.com/issues/42",
      repo: "/home/ubuntu/git/acme/demo-app",
      baseBranch: "main",
      prFeedback: {
        reason: "changes_requested",
        commentSummary: "Please keep the existing PR branch",
        branchName: "bugfix/review-branch",
        comments: [],
        prUrl: "https://example.com/pull/2",
      },
    });

    expect(message).toContain("Required branch: bugfix/review-branch");
    expect(message).toContain("Required worktree: /home/ubuntu/git/acme/demo-app.worktrees/bugfix/review-branch");
    expect(message).toContain("Before editing any file, create or reuse the required worktree above and work only there.");
    expect(message).not.toContain("Required branch: feature/42-demo-app");
  });
});
