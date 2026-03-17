import { describe, expect, it, vi } from "vitest";
import { applyNotifyLabel } from "../../lib/tools/helpers.js";
import type { Project } from "../../lib/projects/types.js";

describe("tool helpers", () => {
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
});
