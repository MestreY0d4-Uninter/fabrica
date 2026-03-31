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

    expect(message).not.toContain("When you finish this task, you MUST invoke the `work_finish`");
    expect(message).not.toContain("Never end your session without calling work_finish.");
  });
});
