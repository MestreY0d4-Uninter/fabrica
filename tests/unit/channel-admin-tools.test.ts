import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChannelUnlinkTool } from "../../lib/tools/admin/channel-unlink.js";
import { DATA_DIR } from "../../lib/setup/constants.js";

describe("channel admin tools", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("channel_unlink supports the same channel family selection as channel_link", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-channel-unlink-"));
    tempDirs.push(workspaceDir);
    await fs.mkdir(path.join(workspaceDir, DATA_DIR), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, DATA_DIR, "projects.json"),
      JSON.stringify({
        projects: {
          demo: {
            slug: "demo",
            name: "Demo",
            repo: "/tmp/demo",
            groupName: "Project: Demo",
            deployUrl: "",
            baseBranch: "main",
            deployBranch: "main",
            channels: [
              { channelId: "discord-room", channel: "discord", name: "primary", events: ["*"] },
              { channelId: "-1003709213169", channel: "telegram", messageThreadId: 101, name: "forum", events: ["*"] },
            ],
            workers: {},
          },
        },
      }, null, 2),
      "utf-8",
    );

    const tool = createChannelUnlinkTool({} as any)({
      workspaceDir,
      messageChannel: "discord",
    } as any);

    const result = await tool.execute("call-1", {
      channelId: "discord-room",
      channel: "discord",
      project: "demo",
      confirm: true,
    });

    expect(result).toBeTruthy();

    const saved = JSON.parse(await fs.readFile(path.join(workspaceDir, DATA_DIR, "projects.json"), "utf-8")) as {
      projects: Record<string, { channels: Array<{ channelId: string; channel: string }> }>;
    };
    expect(saved.projects.demo?.channels).toEqual([
      expect.objectContaining({ channelId: "-1003709213169", channel: "telegram" }),
    ]);
  });
});
