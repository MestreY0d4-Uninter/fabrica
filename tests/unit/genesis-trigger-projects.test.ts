import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { updateProjectTopic } from "../../scripts/genesis-trigger-projects.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
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
      }),
    );
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("updates messageThreadId for matching channel", async () => {
    const result = await updateProjectTopic({
      workspaceDir,
      slug: "my-project",
      channelId: "-100123",
      messageThreadId: 42,
    });
    expect(result.success).toBe(true);
  });

  it("returns error when project does not exist", async () => {
    const result = await updateProjectTopic({
      workspaceDir,
      slug: "nonexistent",
      channelId: "-100123",
      messageThreadId: 42,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns error when no matching channel found", async () => {
    const result = await updateProjectTopic({
      workspaceDir,
      slug: "my-project",
      channelId: "-100999",
      messageThreadId: 42,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("channel");
  });
});
