import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureDefaultFiles } from "../../lib/setup/workspace.js";
import { migrateWorkspaceWorkflowFiles } from "../../lib/setup/workflow-migration.js";
import { DATA_DIR } from "../../lib/setup/constants.js";

describe("workspace workflow migration", () => {
  it("backs up and removes reviewer merge actions from an existing workflow.yaml", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-migration-"));
    try {
      const workflowPath = path.join(ws, DATA_DIR, "workflow.yaml");
      await fs.mkdir(path.dirname(workflowPath), { recursive: true });
      await fs.writeFile(workflowPath, [
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
        "    toTest:",
        "      type: queue",
        "      role: tester",
        "      label: To Test",
        "      color: \"#5bc0de\"",
      ].join("\n"), "utf-8");

      await ensureDefaultFiles(ws);

      const after = await fs.readFile(workflowPath, "utf-8");
      expect(after).not.toContain("mergePr");
      await expect(fs.access(`${workflowPath}.bak`)).resolves.toBeUndefined();
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("audits addedActions when final tester merge actions are restored", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-migration-"));
    try {
      const workflowPath = path.join(ws, DATA_DIR, "workflow.yaml");
      await fs.mkdir(path.dirname(workflowPath), { recursive: true });
      await fs.writeFile(workflowPath, [
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
        "    done:",
        "      type: terminal",
        "      label: Done",
        "      color: \"#0e8a16\"",
      ].join("\n"), "utf-8");

      const results = await migrateWorkspaceWorkflowFiles(ws);
      expect(results).toHaveLength(1);
      expect(results[0]?.fixes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stateKey: "toTest",
            event: "SKIP",
            addedActions: expect.arrayContaining(["mergePr", "gitPull"]),
          }),
        ]),
      );
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});
