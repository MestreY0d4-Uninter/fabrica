import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../lib/config/index.js";
import { DATA_DIR } from "../../lib/setup/migrate-layout.js";

describe("workflow policy normalization", () => {
  it("strips reviewer merge actions from resolved workflow and records metadata", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-policy-"));
    try {
      const dataDir = path.join(ws, DATA_DIR);
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(path.join(dataDir, "workflow.yaml"), [
        "workflow:",
        "  states:",
        "    toReview:",
        "      type: queue",
        "      role: reviewer",
        "      label: To Review",
        "      color: \"#7057ff\"",
        "      on:",
        "        APPROVED:",
        "          target: toTest",
        "          actions:",
        "            - mergePr",
        "            - gitPull",
        "    reviewing:",
        "      type: active",
        "      role: reviewer",
        "      label: Reviewing",
        "      color: \"#c5def5\"",
        "      on:",
        "        APPROVE:",
        "          target: toTest",
        "          actions:",
        "            - mergePr",
        "            - gitPull",
      ].join("\n"), "utf-8");

      const config = await loadConfig(ws);
      expect(config.workflowMeta.sourceLayers).toContain("workspace");
      expect(config.workflowMeta.normalizationFixes).toHaveLength(2);
      expect(config.workflowMeta.keyTransitions.toReviewApproved).not.toContain("mergePr");
      expect(config.workflowMeta.keyTransitions.reviewingApprove).not.toContain("mergePr");
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("restores final merge actions without losing sibling transitions when workspace workflow overrides states sparsely", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-policy-"));
    try {
      const dataDir = path.join(ws, DATA_DIR);
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(path.join(dataDir, "workflow.yaml"), [
        "workflow:",
        "  testPolicy: agent",
        "  states:",
        "    toTest:",
        "      type: queue",
        "      role: tester",
        "      label: To Test",
        "      color: \"#5bc0de\"",
        "      on:",
        "        SKIP:",
          "          target: done",
          "          actions:",
          "            - closeIssue",
        "    testing:",
        "      type: active",
        "      role: tester",
        "      label: Testing",
        "      color: \"#9b59b6\"",
        "      on:",
        "        PASS:",
        "          target: done",
        "          actions:",
        "            - closeIssue",
      ].join("\n"), "utf-8");

      const config = await loadConfig(ws);
      expect(config.workflow.states.toTest?.on?.PICKUP).toBe("testing");
      expect(config.workflowMeta.keyTransitions.toTestSkip).toEqual(["mergePr", "gitPull", "closeIssue"]);
      expect(config.workflowMeta.keyTransitions.testingPass).toEqual(["mergePr", "gitPull", "closeIssue"]);
      expect(config.workflowMeta.normalizationFixes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stateKey: "toTest",
            event: "SKIP",
            reason: "missing_final_merge_before_close",
            addedActions: expect.arrayContaining(["mergePr", "gitPull"]),
          }),
          expect.objectContaining({
            stateKey: "testing",
            event: "PASS",
            reason: "missing_final_merge_before_close",
            addedActions: expect.arrayContaining(["mergePr", "gitPull"]),
          }),
        ]),
      );
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});
