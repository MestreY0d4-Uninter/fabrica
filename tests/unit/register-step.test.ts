import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";
import { DATA_DIR } from "../../lib/setup/migrate-layout.js";

const {
  mockRegisterProject,
  mockAdaptStepRunCommand,
} = vi.hoisted(() => ({
  mockRegisterProject: vi.fn(),
  mockAdaptStepRunCommand: vi.fn(),
}));

vi.mock("../../lib/tools/admin/project-register.js", () => ({
  registerProject: mockRegisterProject,
  adaptStepRunCommand: mockAdaptStepRunCommand,
}));

import { registerStep } from "../../lib/intake/steps/register.js";

async function readAuditEvents(workspaceDir: string): Promise<Array<Record<string, unknown>>> {
  const filePath = path.join(workspaceDir, DATA_DIR, "log", "audit.log");
  const content = await fs.readFile(filePath, "utf-8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("registerStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdaptStepRunCommand.mockReturnValue(vi.fn());
  });

  it("emits project_registered audit event with routing metadata", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-register-"));
    const payload: GenesisPayload = {
      session_id: "sid-1",
      timestamp: new Date().toISOString(),
      step: "scaffold",
      raw_idea: "Example",
      answers: {},
      metadata: {
        source: "test",
        factory_change: false,
        channel_id: "-100123",
      },
      scaffold: {
        created: true,
        project_slug: "demo",
        repo_url: "https://github.com/acme/demo",
      },
    };
    const ctx: StepContext = {
      workspaceDir,
      homeDir: workspaceDir,
      log: () => {},
      runCommand: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
    };

    mockRegisterProject.mockResolvedValue({
      success: true,
      project: "demo",
      projectSlug: "demo",
      channelId: "-100123",
      messageThreadId: 42,
      repo: "https://github.com/acme/demo",
      repoRemote: "https://github.com/acme/demo.git",
      baseBranch: "main",
      deployBranch: "main",
      labelsCreated: 10,
      promptsScaffolded: true,
      isNewProject: true,
      activeWorkflow: {
        reviewPolicy: "human",
        testPhase: true,
        hint: "hint",
      },
      announcement: "ok",
    });

    try {
      const result = await registerStep.execute(payload, ctx);

      expect(mockRegisterProject).toHaveBeenCalledWith(expect.objectContaining({
        workspaceDir,
        route: {
          channel: "telegram",
          channelId: "-100123",
          messageThreadId: undefined,
        },
        name: "demo",
        repo: "https://github.com/acme/demo",
      }));
      expect(result.metadata.project_registered).toBe(true);
      expect(result.metadata.channel_id).toBe("-100123");
      expect(result.metadata.message_thread_id).toBe(42);

      const events = await readAuditEvents(workspaceDir);
      expect(events).toHaveLength(1);
      expect(events[0]?.event).toBe("project_registered");
      expect(events[0]?.projectSlug).toBe("demo");
      expect(events[0]?.channelId).toBe("-100123");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("requests topic creation for telegram DM bootstrap", async () => {
    const payload: GenesisPayload = {
      session_id: "sid-3",
      timestamp: new Date().toISOString(),
      step: "scaffold",
      raw_idea: "Example",
      answers: {},
      metadata: {
        source: "telegram-dm-bootstrap",
        factory_change: false,
        channel_id: "6951571380",
      },
      scaffold: {
        created: true,
        project_slug: "demo",
        repo_url: "https://github.com/acme/demo",
      },
    };
    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
      runtime: {} as any,
      config: {} as any,
      pluginConfig: {} as any,
    };

    mockRegisterProject.mockResolvedValue({
      success: true,
      project: "demo",
      projectSlug: "demo",
      channelId: "-1003709213169",
      messageThreadId: 501,
      repo: "https://github.com/acme/demo",
      repoRemote: "https://github.com/acme/demo.git",
      baseBranch: "main",
      deployBranch: "main",
      labelsCreated: 10,
      promptsScaffolded: true,
      isNewProject: true,
      activeWorkflow: {
        reviewPolicy: "agent",
        testPhase: true,
        hint: "hint",
      },
      announcement: "ok",
    });

    const result = await registerStep.execute(payload, ctx);

    expect(mockRegisterProject).toHaveBeenCalledWith(expect.objectContaining({
      createProjectTopic: true,
      projectWorkflowConfig: {
        workflow: {
          reviewPolicy: "agent",
        },
      },
      route: {
        channel: "telegram",
        channelId: "6951571380",
        messageThreadId: undefined,
      },
    }));
    expect(result.metadata.channel_id).toBe("-1003709213169");
    expect(result.metadata.message_thread_id).toBe(501);
  });

  it("fails closed when DM bootstrap resolves a non-agent review policy", async () => {
    const payload: GenesisPayload = {
      session_id: "sid-3b",
      timestamp: new Date().toISOString(),
      step: "scaffold",
      raw_idea: "Example",
      answers: {},
      metadata: {
        source: "telegram-dm-bootstrap",
        factory_change: false,
        channel_id: "6951571380",
      },
      scaffold: {
        created: true,
        project_slug: "demo",
        repo_url: "https://github.com/acme/demo",
      },
    };
    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
      runtime: {} as any,
      config: {} as any,
      pluginConfig: {} as any,
    };

    mockRegisterProject.mockResolvedValue({
      success: true,
      project: "demo",
      projectSlug: "demo",
      channelId: "-1003709213169",
      messageThreadId: 501,
      repo: "https://github.com/acme/demo",
      repoRemote: "https://github.com/acme/demo.git",
      baseBranch: "main",
      deployBranch: "main",
      labelsCreated: 10,
      promptsScaffolded: true,
      isNewProject: true,
      activeWorkflow: {
        reviewPolicy: "human",
        testPhase: true,
        hint: "hint",
      },
      announcement: "ok",
    });

    await expect(registerStep.execute(payload, ctx)).rejects.toThrow(
      'Programmatic source "telegram-dm-bootstrap" registration resolved reviewPolicy="human" instead of "agent"',
    );
  });

  it("fails closed when no channel binding is available", async () => {
    const payload: GenesisPayload = {
      session_id: "sid-2",
      timestamp: new Date().toISOString(),
      step: "scaffold",
      raw_idea: "Example",
      answers: {},
      metadata: {
        source: "test",
        factory_change: false,
      },
      scaffold: {
        created: true,
        project_slug: "demo",
        repo_url: "https://github.com/acme/demo",
      },
    };
    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
    };

    expect(mockRegisterProject).not.toHaveBeenCalled();
    await expect(registerStep.execute(payload, ctx)).rejects.toThrow(
      "Missing channel binding for project registration",
    );
  });

  it("applies agent reviewPolicy for genesis-trigger-script source without topic creation", async () => {
    const payload: GenesisPayload = {
      session_id: "sid-5",
      timestamp: new Date().toISOString(),
      step: "scaffold",
      raw_idea: "Example",
      answers: {},
      metadata: {
        source: "genesis-trigger-script",
        factory_change: false,
        channel_id: "6951571380",
      },
      scaffold: {
        created: true,
        project_slug: "demo",
        repo_url: "https://github.com/acme/demo",
      },
    };
    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
      runtime: {} as any,
      config: {} as any,
      pluginConfig: {} as any,
    };

    mockRegisterProject.mockResolvedValue({
      success: true,
      project: "demo",
      projectSlug: "demo",
      channelId: "-1003709213169",
      messageThreadId: 502,
      repo: "https://github.com/acme/demo",
      repoRemote: "https://github.com/acme/demo.git",
      baseBranch: "main",
      deployBranch: "main",
      labelsCreated: 10,
      promptsScaffolded: true,
      isNewProject: true,
      activeWorkflow: {
        reviewPolicy: "agent",
        testPhase: true,
        hint: "hint",
      },
      announcement: "ok",
    });

    const result = await registerStep.execute(payload, ctx);

    expect(mockRegisterProject).toHaveBeenCalledWith(expect.objectContaining({
      createProjectTopic: false,
      projectWorkflowConfig: {
        workflow: {
          reviewPolicy: "agent",
        },
      },
      route: {
        channel: "telegram",
        channelId: "6951571380",
        messageThreadId: undefined,
      },
    }));
    expect(result.metadata.channel_id).toBe("-1003709213169");
    expect(result.metadata.message_thread_id).toBe(502);
  });

  it("fails closed when project_register rejects", async () => {
    const payload: GenesisPayload = {
      session_id: "sid-4",
      timestamp: new Date().toISOString(),
      step: "scaffold",
      raw_idea: "Example",
      answers: {},
      metadata: {
        source: "telegram-dm-bootstrap",
        factory_change: false,
        channel_id: "6951571380",
      },
      scaffold: {
        created: true,
        project_slug: "demo",
        repo_url: "https://github.com/acme/demo",
      },
    };
    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
      runtime: {} as any,
      config: {} as any,
      pluginConfig: {} as any,
    };

    mockRegisterProject.mockRejectedValue(new Error("DM bootstrap registration requires a Telegram topic association"));

    await expect(registerStep.execute(payload, ctx)).rejects.toThrow(
      "DM bootstrap registration requires a Telegram topic association",
    );
  });
});
