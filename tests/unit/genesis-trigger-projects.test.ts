import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { updateProjectTopic } from "../../scripts/genesis-trigger-projects.js";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("updateProjectTopic", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "gt-test-"));
    const dataDir = join(workspaceDir, "fabrica");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "projects.json"),
      JSON.stringify({
        projects: {
          "my-project": {
            slug: "my-project",
            channels: [{ channel: "telegram", channelId: "-100123" }],
          },
        },
      }, null, 2),
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("fails closed because post-hoc topic patching was removed from the registration flow", async () => {
    const before = await readFile(join(workspaceDir, "fabrica", "projects.json"), "utf-8");

    const result = await updateProjectTopic({
      workspaceDir,
      slug: "my-project",
      channelId: "-100123",
      messageThreadId: 42,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Post-hoc Telegram topic patching has been removed");

    const after = await readFile(join(workspaceDir, "fabrica", "projects.json"), "utf-8");
    expect(after).toBe(before);
  });
});
