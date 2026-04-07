import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeProjects, readProjects } from "../../lib/projects/index.js";
import type { ProjectsData } from "../../lib/projects/types.js";
import { TestProvider } from "../../lib/testing/test-provider.js";

let workspaceDir = "";
let provider: TestProvider;
let project: any;

vi.mock("../../lib/audit.js", () => ({
  log: vi.fn(async () => {}),
}));

vi.mock("../../lib/config/index.js", () => ({
  loadConfig: vi.fn(async () => ({ workflow: { initial: "planning", states: { planning: { label: "Planning" } } } })),
}));

vi.mock("../../lib/tools/helpers.js", () => ({
  requireWorkspaceDir: (ctx: { workspaceDir?: string }) => {
    if (!ctx.workspaceDir) throw new Error("No workspace directory available in tool context");
    return ctx.workspaceDir;
  },
  resolveProjectFromContext: vi.fn(async () => ({
    data: await readProjects(workspaceDir),
    project,
    route: { channel: "telegram", channelId: project.channels[0].channelId },
  })),
  resolveProvider: vi.fn(async () => ({ provider, type: "github" })),
  autoAssignOwnerLabel: vi.fn(async () => {}),
  applyNotifyLabel: vi.fn(() => {}),
}));

import { createTaskCreateTool } from "../../lib/tools/tasks/task-create.js";

describe("task_create parent/child runtime alignment", () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-task-create-"));
    provider = new TestProvider();
    provider.seedIssue({ iid: 42, title: "Epic", labels: ["Planning"] });
    project = {
      slug: "demo",
      name: "demo",
      repo: "/tmp/demo",
      repoRemote: "https://github.com/acme/demo",
      groupName: "Project: demo",
      deployUrl: "",
      baseBranch: "main",
      deployBranch: "main",
      channels: [{ channelId: "demo", channel: "telegram", name: "primary" }],
      provider: "github",
      workers: {},
      issueRuntime: {
        "42": {
          childIssueIds: [],
        },
      },
      stack: null,
      environment: null,
    };
    const data: ProjectsData = { projects: { demo: project } };
    await writeProjects(workspaceDir, data);
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("persists canonical parent/child runtime metadata when creating a child task manually", async () => {
    const tool = createTaskCreateTool({ runCommand: vi.fn() } as any)({ workspaceDir } as any);

    const result = await tool.execute("call-1", {
      channelId: "demo",
      title: "Child task",
      description: "Do one part of the epic",
      parentIssueId: 42,
    }) as any;

    const payload = result?.details ?? result?.json ?? result;
    expect(payload.success).toBe(true);

    const persisted = await readProjects(workspaceDir);
    const parentRuntime = persisted.projects.demo?.issueRuntime?.["42"];
    const childId = String(payload.issue.id);
    const childRuntime = persisted.projects.demo?.issueRuntime?.[childId];

    expect(parentRuntime?.childIssueIds).toContain(payload.issue.id);
    expect(parentRuntime?.decompositionMode).toBe("parent_child");
    expect(parentRuntime?.decompositionStatus).toBe("active");
    expect(childRuntime?.parentIssueId).toBe(42);
    expect(childRuntime?.decompositionMode).toBe("none");
    expect(childRuntime?.decompositionStatus).toBeNull();
  });
});
