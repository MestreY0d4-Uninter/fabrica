import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyNotifyLabel, resolveProjectFromContext } from "../../lib/tools/helpers.js";
import type { Project } from "../../lib/projects/types.js";
import { DATA_DIR } from "../../lib/setup/constants.js";

describe("tool helpers", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("routes notify labels to the primary topic when the source channel is the DM helper route", async () => {
    const provider = {
      ensureLabel: vi.fn(async () => undefined),
      addLabel: vi.fn(async () => undefined),
      removeLabels: vi.fn(async () => undefined),
    } as any;

    const project: Project = {
      slug: "demo",
      name: "Demo",
      repo: "/tmp/demo",
      groupName: "Project: Demo",
      deployUrl: "",
      baseBranch: "main",
      deployBranch: "main",
      channels: [
        { channelId: "6951571380", channel: "telegram", name: "dm", events: ["*"] },
        { channelId: "-1003709213169", channel: "telegram", messageThreadId: 621, name: "primary", events: ["*"] },
      ],
      workers: {},
    };

    applyNotifyLabel(provider, 42, project, "6951571380", []);
    await Promise.resolve();

    expect(provider.ensureLabel).toHaveBeenCalledWith("notify:telegram:primary", expect.any(String));
    expect(provider.addLabel).toHaveBeenCalledWith(42, "notify:telegram:primary");
  });

  it("resolveProjectFromContext keeps the full route tuple, including accountId", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-tool-helpers-"));
    tempDirs.push(workspaceDir);
    await fs.mkdir(path.join(workspaceDir, DATA_DIR), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, DATA_DIR, "projects.json"),
      JSON.stringify({
        projects: {
          alpha: {
            slug: "alpha",
            name: "Alpha",
            repo: "/tmp/alpha",
            groupName: "Project: Alpha",
            deployUrl: "",
            baseBranch: "main",
            deployBranch: "main",
            channels: [
              {
                channel: "telegram",
                channelId: "-1003709213169",
                messageThreadId: 101,
                accountId: "acct-a",
                name: "primary",
                events: ["*"],
              },
            ],
            workers: {},
          },
          beta: {
            slug: "beta",
            name: "Beta",
            repo: "/tmp/beta",
            groupName: "Project: Beta",
            deployUrl: "",
            baseBranch: "main",
            deployBranch: "main",
            channels: [
              {
                channel: "telegram",
                channelId: "-1003709213169",
                messageThreadId: 101,
                accountId: "acct-b",
                name: "primary",
                events: ["*"],
              },
            ],
            workers: {},
          },
        },
      }, null, 2),
      "utf-8",
    );

    const resolved = await resolveProjectFromContext(
      workspaceDir,
      {
        workspaceDir,
        messageChannel: "telegram",
        messageThreadId: 101,
        agentAccountId: "acct-b",
      },
      "-1003709213169",
    );

    expect(resolved.project.slug).toBe("beta");
    expect(resolved.route.accountId).toBe("acct-b");
  });
});
