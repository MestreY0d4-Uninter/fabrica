import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerProject } from "../../lib/tools/admin/project-register.js";
import { DATA_DIR } from "../../lib/setup/constants.js";
import { TestProvider } from "../../lib/testing/test-provider.js";

const {
  mockCreateProvider,
  mockCreateProjectForumTopic,
} = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
  mockCreateProjectForumTopic: vi.fn(),
}));

vi.mock("../../lib/providers/index.js", () => ({
  createProvider: mockCreateProvider,
}));

vi.mock("../../lib/telegram/topic-service.js", () => ({
  createProjectForumTopic: mockCreateProjectForumTopic,
}));

describe("registerProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("materializes a project workflow override with reviewPolicy agent for autonomous DM bootstrap", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-project-register-"));
    await fs.mkdir(path.join(workspaceDir, DATA_DIR), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, DATA_DIR, "projects.json"),
      JSON.stringify({ projects: {} }, null, 2),
      "utf-8",
    );
    const provider = new TestProvider();
    mockCreateProvider.mockResolvedValue({ provider, type: "github" });
    mockCreateProjectForumTopic.mockResolvedValue({
      chatId: "-1003709213169",
      topicId: 602,
      name: "demo-autonomous",
    });

    try {
      const result = await registerProject({
        workspaceDir,
        route: {
          channel: "telegram",
          channelId: "6951571380",
        },
        name: "demo-autonomous",
        repo: "/tmp/demo-autonomous",
        runCommand: vi.fn(async () => ({
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        })) as any,
        runtime: {} as any,
        config: {} as any,
        pluginConfig: {
          telegram: {
            projectsForumChatId: "-1003709213169",
          },
        },
        baseBranch: "main",
        createProjectTopic: true,
      });

      const workflowPath = path.join(workspaceDir, DATA_DIR, "projects", "demo-autonomous", "workflow.yaml");
      const projectsPath = path.join(workspaceDir, DATA_DIR, "projects.json");
      const workflowContent = await fs.readFile(workflowPath, "utf-8");
      const projects = JSON.parse(await fs.readFile(projectsPath, "utf-8")) as {
        projects: Record<string, { channels: Array<{ channelId: string; messageThreadId?: number }> }>;
      };

      expect(result.channelId).toBe("-1003709213169");
      expect(result.messageThreadId).toBe(602);
      expect(result.workflowOverrideCreated).toBe(true);
      expect(result.activeWorkflow.reviewPolicy).toBe("agent");
      expect(workflowContent).toContain("reviewPolicy: agent");
      expect(projects.projects["demo-autonomous"]?.channels[0]).toEqual(expect.objectContaining({
        channelId: "-1003709213169",
        messageThreadId: 602,
      }));
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("fails closed when Telegram topic creation falls back to the general topic", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-project-register-"));
    await fs.mkdir(path.join(workspaceDir, DATA_DIR), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, DATA_DIR, "projects.json"),
      JSON.stringify({ projects: {} }, null, 2),
      "utf-8",
    );
    const provider = new TestProvider();
    mockCreateProvider.mockResolvedValue({ provider, type: "github" });
    mockCreateProjectForumTopic.mockResolvedValue({
      chatId: "-1003709213169",
      topicId: 1,
      name: "demo-autonomous",
      isFallback: true,
    });

    try {
      await expect(registerProject({
        workspaceDir,
        route: {
          channel: "telegram",
          channelId: "6951571380",
        },
        name: "demo-autonomous",
        repo: "/tmp/demo-autonomous",
        runCommand: vi.fn(async () => ({
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        })) as any,
        runtime: {} as any,
        config: {} as any,
        pluginConfig: {
          telegram: {
            projectsForumChatId: "-1003709213169",
          },
        },
        baseBranch: "main",
        createProjectTopic: true,
      })).rejects.toThrow("dedicated Telegram topic");

      const projects = JSON.parse(await fs.readFile(
        path.join(workspaceDir, DATA_DIR, "projects.json"),
        "utf-8",
      )) as { projects: Record<string, unknown> };
      expect(projects.projects["demo-autonomous"]).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("fails closed when an existing slug points to a different repository", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-project-register-"));
    await fs.mkdir(path.join(workspaceDir, DATA_DIR), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, DATA_DIR, "projects.json"),
      JSON.stringify({
        projects: {
          "demo-autonomous": {
            slug: "demo-autonomous",
            name: "demo-autonomous",
            repo: "/tmp/existing-repo",
            repoRemote: "https://github.com/acme/existing.git",
            groupName: "Project: Demo Autonomous",
            deployUrl: "",
            baseBranch: "main",
            deployBranch: "main",
            channels: [],
            workers: {},
            provider: "github",
          },
        },
      }, null, 2),
      "utf-8",
    );
    const provider = new TestProvider();
    mockCreateProvider.mockResolvedValue({ provider, type: "github" });

    try {
      await expect(registerProject({
        workspaceDir,
        route: {
          channel: "telegram",
          channelId: "6951571380",
        },
        name: "demo-autonomous",
        repo: "/tmp/different-repo",
        runCommand: vi.fn(async () => ({
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        })) as any,
        runtime: {} as any,
        config: {} as any,
        pluginConfig: {},
        baseBranch: "main",
      })).rejects.toThrow("already points to a different repository");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
