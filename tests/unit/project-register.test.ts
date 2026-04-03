import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerProject } from "../../lib/tools/admin/project-register.js";
import * as projectsModule from "../../lib/projects/index.js";
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

const tempDirs: string[] = [];

async function makeLocalRepo(files: Record<string, string>): Promise<string> {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-project-register-repo-"));
  tempDirs.push(repoDir);
  await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
    const filePath = path.join(repoDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
  }));
  return repoDir;
}

describe("registerProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
    }
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
    const repoDir = await makeLocalRepo({
      "pyproject.toml": "[project]\nname='demo-autonomous'\nversion='0.1.0'\n",
    });

    try {
      const result = await registerProject({
        workspaceDir,
        route: {
          channel: "telegram",
          channelId: "6951571380",
        },
        name: "demo-autonomous",
        repo: repoDir,
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
        stack: "python-cli",
      });

      const workflowPath = path.join(workspaceDir, DATA_DIR, "projects", "demo-autonomous", "workflow.yaml");
      const projectsPath = path.join(workspaceDir, DATA_DIR, "projects.json");
      const workflowContent = await fs.readFile(workflowPath, "utf-8");
      const projects = JSON.parse(await fs.readFile(projectsPath, "utf-8")) as {
        projects: Record<string, {
          channels: Array<{ channelId: string; messageThreadId?: number }>;
          stack?: string | null;
          environment?: unknown;
        }>;
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
      expect(projects.projects["demo-autonomous"]?.stack).toBe("python-cli");
      expect(projects.projects["demo-autonomous"]?.environment).toBeNull();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a stack-specific local repo path lacks scaffold manifests", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-project-register-"));
    await fs.mkdir(path.join(workspaceDir, DATA_DIR), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, DATA_DIR, "projects.json"),
      JSON.stringify({ projects: {} }, null, 2),
      "utf-8",
    );
    const repoDir = await makeLocalRepo({
      "README.md": "# demo\n",
    });
    const provider = new TestProvider();
    mockCreateProvider.mockResolvedValue({ provider, type: "github" });

    try {
      await expect(registerProject({
        workspaceDir,
        route: {
          channel: "telegram",
          channelId: "6951571380",
        },
        name: "demo-node",
        repo: repoDir,
        runCommand: vi.fn(async () => ({
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        })) as any,
        pluginConfig: {},
        baseBranch: "main",
        stack: "node-cli",
      })).rejects.toThrow(/does not contain package\.json/i);

      const projects = JSON.parse(await fs.readFile(
        path.join(workspaceDir, DATA_DIR, "projects.json"),
        "utf-8",
      )) as { projects: Record<string, unknown> };
      expect(projects.projects["demo-node"]).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a Python repo path lacks pyproject, requirements, and uv.lock", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-project-register-"));
    await fs.mkdir(path.join(workspaceDir, DATA_DIR), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, DATA_DIR, "projects.json"),
      JSON.stringify({ projects: {} }, null, 2),
      "utf-8",
    );
    const repoDir = await makeLocalRepo({
      "README.md": "# demo\n",
    });
    const provider = new TestProvider();
    mockCreateProvider.mockResolvedValue({ provider, type: "github" });

    try {
      await expect(registerProject({
        workspaceDir,
        route: {
          channel: "telegram",
          channelId: "6951571380",
        },
        name: "demo-python",
        repo: repoDir,
        runCommand: vi.fn(async () => ({
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        })) as any,
        pluginConfig: {},
        baseBranch: "main",
        stack: "python-cli",
      })).rejects.toThrow(/does not contain pyproject\.toml, requirements\.txt, or uv\.lock/i);

      const projects = JSON.parse(await fs.readFile(
        path.join(workspaceDir, DATA_DIR, "projects.json"),
        "utf-8",
      )) as { projects: Record<string, unknown> };
      expect(projects.projects["demo-python"]).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not leave workflow residue without durable project truth", async () => {
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

    const writeProjectsSpy = vi.spyOn(projectsModule, "writeProjects");
    writeProjectsSpy.mockRejectedValueOnce(new Error("projects.json write failed"));

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
      })).rejects.toThrow("projects.json write failed");

      const projects = JSON.parse(await fs.readFile(
        path.join(workspaceDir, DATA_DIR, "projects.json"),
        "utf-8",
      )) as { projects: Record<string, unknown> };
      const workflowPath = path.join(workspaceDir, DATA_DIR, "projects", "demo-autonomous", "workflow.yaml");

      await expect(fs.access(workflowPath)).rejects.toThrow();
      expect(projects.projects["demo-autonomous"]).toBeUndefined();
    } finally {
      writeProjectsSpy.mockRestore();
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

  it("does not leave workflow override residue behind when autonomous registration fails before project truth is written", async () => {
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

      const workflowPath = path.join(
        workspaceDir,
        DATA_DIR,
        "projects",
        "demo-autonomous",
        "workflow.yaml",
      );
      await expect(fs.access(workflowPath)).rejects.toMatchObject({ code: "ENOENT" });
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
