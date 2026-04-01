import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerProject } from "../../lib/tools/admin/project-register.js";
import { DATA_DIR } from "../../lib/setup/constants.js";
import { TestProvider } from "../../lib/testing/test-provider.js";
import { buildForumTopicArtifactId } from "../../lib/intake/lib/artifact-ids.js";

const {
  mockCreateProvider,
  mockCreateProjectForumTopic,
  mockAuditLog,
} = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
  mockCreateProjectForumTopic: vi.fn(),
  mockAuditLog: vi.fn(),
}));

vi.mock("../../lib/providers/index.js", () => ({
  createProvider: mockCreateProvider,
}));

vi.mock("../../lib/telegram/topic-service.js", () => ({
  createProjectForumTopic: mockCreateProjectForumTopic,
}));

vi.mock("../../lib/audit.js", () => ({
  log: mockAuditLog,
}));

describe("registerProject orphan handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rolls back project truth and local register residue when a post-write failure occurs", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-register-orphaning-"));
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
    mockAuditLog.mockRejectedValueOnce(new Error("audit write failed"));

    try {
      let captured: unknown;
      try {
        await registerProject({
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
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(Error);
      expect((captured as Error).message).toContain("audit write failed");
      expect((captured as Error & { artifacts?: Array<{ type: string; id: string }> }).artifacts).toEqual([
        {
          type: "forum_topic",
          id: buildForumTopicArtifactId("-1003709213169", 602),
        },
      ]);

      const projects = JSON.parse(await fs.readFile(
        path.join(workspaceDir, DATA_DIR, "projects.json"),
        "utf-8",
      )) as { projects: Record<string, unknown> };
      const projectDir = path.join(workspaceDir, DATA_DIR, "projects", "demo-autonomous");

      expect(projects.projects["demo-autonomous"]).toBeUndefined();
      await expect(fs.access(path.join(projectDir, "workflow.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.join(projectDir, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
