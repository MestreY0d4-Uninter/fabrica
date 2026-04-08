import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const {
  mockRunDoctor,
  mockRunHeartbeatSweep,
  mockRunTriageSweep,
  mockRunHealthSweep,
  mockRunSecurityDoctor,
  mockProcessPendingGitHubEventsForWorkspace,
  mockReplayGitHubDeliveryForWorkspace,
  mockReconcileGitHubPullRequestForWorkspace,
  mockCleanupWorkspace,
  mockRunSetup,
} = vi.hoisted(() => ({
  mockRunDoctor: vi.fn(),
  mockRunHeartbeatSweep: vi.fn(),
  mockRunTriageSweep: vi.fn(),
  mockRunHealthSweep: vi.fn(),
  mockRunSecurityDoctor: vi.fn(),
  mockProcessPendingGitHubEventsForWorkspace: vi.fn(),
  mockReplayGitHubDeliveryForWorkspace: vi.fn(),
  mockReconcileGitHubPullRequestForWorkspace: vi.fn(),
  mockCleanupWorkspace: vi.fn(),
  mockRunSetup: vi.fn(),
}));

vi.mock("../../lib/setup/doctor.js", () => ({
  runDoctor: mockRunDoctor,
}));

vi.mock("../../lib/services/heartbeat/cli-sweeps.js", () => ({
  runHeartbeatSweep: mockRunHeartbeatSweep,
  runTriageSweep: mockRunTriageSweep,
  runHealthSweep: mockRunHealthSweep,
}));

vi.mock("../../lib/setup/security-doctor.js", () => ({
  runSecurityDoctor: mockRunSecurityDoctor,
}));

vi.mock("../../lib/setup/index.js", () => ({
  runSetup: mockRunSetup,
}));

vi.mock("../../lib/github/process-events.js", () => ({
  processPendingGitHubEventsForWorkspace: mockProcessPendingGitHubEventsForWorkspace,
  replayGitHubDeliveryForWorkspace: mockReplayGitHubDeliveryForWorkspace,
  reconcileGitHubPullRequestForWorkspace: mockReconcileGitHubPullRequestForWorkspace,
}));

vi.mock("../../lib/setup/agent.js", () => ({
  cleanupWorkspace: mockCleanupWorkspace,
}));

import { registerCli } from "../../lib/setup/cli.js";

function createCtx() {
  return {
    runtime: {
      config: {
        loadConfig: () => ({
          agents: { defaults: { workspace: "/tmp/default-workspace" } },
        }),
      },
    },
    runCommand: vi.fn(),
    pluginConfig: { work_heartbeat: { enabled: true } },
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as any;
}

describe("fabrica CLI operational wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunHeartbeatSweep.mockResolvedValue({
      agents: [{ agentId: "main", workspace: "/tmp/ws" }],
      totalPickups: 1,
      totalHealthFixes: 2,
      totalSkipped: 0,
      totalReviewTransitions: 0,
      totalReviewSkipTransitions: 0,
      totalTestSkipTransitions: 0,
    });
    mockRunTriageSweep.mockResolvedValue({
      agents: [{ agentId: "main", workspace: "/tmp/ws" }],
      totalPickups: 1,
      totalHealthFixes: 0,
      totalSkipped: 0,
      totalReviewTransitions: 0,
      totalReviewSkipTransitions: 0,
      totalTestSkipTransitions: 0,
      githubEventsProcessed: 0,
      githubEventsFailed: 0,
      githubEventsSkipped: 0,
    });
    mockRunHealthSweep.mockResolvedValue({
      agents: [{ agentId: "main", workspace: "/tmp/ws" }],
      projectsScanned: 3,
      healthFixes: 2,
    });
    mockRunDoctor.mockResolvedValue({
      checks: [],
      errors: 0,
      warnings: 0,
      fixed: 0,
    });
    mockRunSecurityDoctor.mockResolvedValue({
      checks: [],
      errors: 0,
      warnings: 0,
    });
    mockProcessPendingGitHubEventsForWorkspace.mockResolvedValue({
      backend: "sqlite",
      pending: 2,
      processed: 2,
      failed: 0,
      skipped: 0,
      qualityGateUpdates: 1,
    });
    mockReplayGitHubDeliveryForWorkspace.mockResolvedValue({
      backend: "sqlite",
      deliveryId: "delivery-1",
      found: true,
      pending: 1,
      processed: 1,
      failed: 0,
      skipped: 0,
      qualityGateUpdates: 1,
    });
    mockReconcileGitHubPullRequestForWorkspace.mockResolvedValue({
      backend: "sqlite",
      prNumber: 42,
      pending: 3,
      processed: 3,
      failed: 0,
      skipped: 0,
      qualityGateUpdates: 2,
    });
    mockCleanupWorkspace.mockResolvedValue(undefined);
    mockRunSetup.mockResolvedValue({
      agentId: "fabrica",
      agentCreated: false,
      workspacePath: "/tmp/default-workspace",
      models: {},
      filesWritten: [],
      warnings: [],
    });
  });

  it("passes ensureGenesis + forumGroupId to runSetup when DM bootstrap is configured", async () => {
    const program = new Command();
    const ctx = createCtx();
    ctx.pluginConfig = {
      work_heartbeat: { enabled: true },
      telegram: {
        bootstrapDmEnabled: true,
        projectsForumChatId: "-1003709213169",
      },
    };
    registerCli(program, ctx);

    await program.parseAsync(["node", "test", "fabrica", "setup", "--workspace", "/tmp/default-workspace"], { from: "node" });

    expect(mockRunSetup).toHaveBeenCalledWith(expect.objectContaining({
      ensureGenesis: true,
      forumGroupId: "-1003709213169",
    }));
  });

  it("does not force genesis setup when the Telegram forum id is missing", async () => {
    const program = new Command();
    const ctx = createCtx();
    ctx.pluginConfig = {
      work_heartbeat: { enabled: true },
      telegram: {
        bootstrapDmEnabled: true,
      },
    };
    registerCli(program, ctx);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await program.parseAsync(["node", "test", "fabrica", "setup", "--workspace", "/tmp/default-workspace"], { from: "node" });

    expect(mockRunSetup).toHaveBeenCalledWith(expect.objectContaining({
      ensureGenesis: false,
      forumGroupId: undefined,
    }));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("FABRICA_PROJECTS_CHANNEL_ID"));
  });

  it("routes `fabrica heartbeat once` through the one-shot heartbeat sweep", async () => {
    const program = new Command();
    registerCli(program, createCtx());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "fabrica",
      "heartbeat",
      "once",
      "--workspace",
      "/tmp/ws",
      "--json",
    ]);

    expect(mockRunHeartbeatSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/ws",
        pluginConfig: { work_heartbeat: { enabled: true } },
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          agents: [{ agentId: "main", workspace: "/tmp/ws" }],
          totalPickups: 1,
          totalHealthFixes: 2,
          totalSkipped: 0,
          totalReviewTransitions: 0,
          totalReviewSkipTransitions: 0,
          totalTestSkipTransitions: 0,
        },
        null,
        2,
      ),
    );
  });

  it("routes `fabrica health sweep` through the health-only sweep", async () => {
    const program = new Command();
    registerCli(program, createCtx());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "fabrica",
      "health",
      "sweep",
      "--agent",
      "main",
      "--json",
    ]);

    expect(mockRunHealthSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          agents: [{ agentId: "main", workspace: "/tmp/ws" }],
          projectsScanned: 3,
          healthFixes: 2,
        },
        null,
        2,
      ),
    );
  });

  it("routes `fabrica config validate` through the doctor engine in read-only mode", async () => {
    const program = new Command();
    registerCli(program, createCtx());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`exit:${code ?? 0}`);
      }) as any);

    await expect(
      program.parseAsync([
        "node",
        "test",
        "fabrica",
        "config",
        "validate",
        "--json",
      ]),
    ).rejects.toThrow("exit:0");

    expect(mockRunDoctor).toHaveBeenCalledWith({
      workspacePath: "/tmp/default-workspace",
      fix: false,
    });
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          checks: [],
          errors: 0,
          warnings: 0,
          fixed: 0,
        },
        null,
        2,
      ),
    );

    exitSpy.mockRestore();
  });

  it("routes `fabrica triage sweep` through the heartbeat sweep", async () => {
    const program = new Command();
    registerCli(program, createCtx());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "fabrica",
      "triage",
      "sweep",
      "--workspace",
      "/tmp/ws",
      "--json",
    ]);

    expect(mockRunTriageSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/ws",
      }),
    );
    expect(logSpy).toHaveBeenCalled();
  });

  it("routes `fabrica workspace cleanup` through the workspace cleanup helper", async () => {
    const program = new Command();
    registerCli(program, createCtx());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "fabrica",
      "workspace",
      "cleanup",
      "--workspace",
      "/tmp/ws",
      "--json",
    ]);

    expect(mockCleanupWorkspace).toHaveBeenCalledWith("/tmp/ws");
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          workspaceDir: "/tmp/ws",
          cleaned: true,
        },
        null,
        2,
      ),
    );
  });

  it("routes `fabrica github process-events` through the GitHub repair loop", async () => {
    const program = new Command();
    registerCli(program, createCtx());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "fabrica",
      "github",
      "process-events",
      "--workspace",
      "/tmp/ws",
      "--json",
    ]);

    expect(mockProcessPendingGitHubEventsForWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/ws",
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          backend: "sqlite",
          pending: 2,
          processed: 2,
          failed: 0,
          skipped: 0,
          qualityGateUpdates: 1,
        },
        null,
        2,
      ),
    );
  });

  it("routes `fabrica github replay` through the replay helper", async () => {
    const program = new Command();
    registerCli(program, createCtx());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "fabrica",
      "github",
      "replay",
      "--delivery",
      "delivery-1",
      "--json",
    ]);

    expect(mockReplayGitHubDeliveryForWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/default-workspace",
        deliveryId: "delivery-1",
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          backend: "sqlite",
          deliveryId: "delivery-1",
          found: true,
          pending: 1,
          processed: 1,
          failed: 0,
          skipped: 0,
          qualityGateUpdates: 1,
        },
        null,
        2,
      ),
    );
  });

  it("routes `fabrica github reconcile-pr` through the reconcile helper", async () => {
    const program = new Command();
    registerCli(program, createCtx());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "fabrica",
      "github",
      "reconcile-pr",
      "--pr",
      "42",
      "--json",
    ]);

    expect(mockReconcileGitHubPullRequestForWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/default-workspace",
        prNumber: 42,
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          backend: "sqlite",
          prNumber: 42,
          pending: 3,
          processed: 3,
          failed: 0,
          skipped: 0,
          qualityGateUpdates: 2,
        },
        null,
        2,
      ),
    );
  });

  it("routes `fabrica doctor security` through the security doctor", async () => {
    const program = new Command();
    registerCli(program, createCtx());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`exit:${code ?? 0}`);
      }) as any);

    await expect(
      program.parseAsync([
        "node",
        "test",
        "fabrica",
        "doctor",
        "security",
        "--openclaw-home",
        "/tmp/oc",
        "--json",
      ]),
    ).rejects.toThrow("exit:0");

    expect(mockRunSecurityDoctor).toHaveBeenCalledWith("/tmp/oc");
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          checks: [],
          errors: 0,
          warnings: 0,
        },
        null,
        2,
      ),
    );

    exitSpy.mockRestore();
  });
});
