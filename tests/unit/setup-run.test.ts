import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateAgent,
  mockEnsureGenesisAgent,
  mockResolveWorkspacePath,
  mockWritePluginConfig,
} = vi.hoisted(() => ({
  mockCreateAgent: vi.fn(),
  mockEnsureGenesisAgent: vi.fn(),
  mockResolveWorkspacePath: vi.fn(),
  mockWritePluginConfig: vi.fn(),
}));

vi.mock("../../lib/setup/agent.js", () => ({
  createAgent: mockCreateAgent,
  ensureGenesisAgent: mockEnsureGenesisAgent,
  resolveWorkspacePath: mockResolveWorkspacePath,
}));

vi.mock("../../lib/setup/config.js", () => ({
  writePluginConfig: mockWritePluginConfig,
}));

let tmpDir: string;
let defaultWorkspace: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-setup-run-"));
  defaultWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-setup-default-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(defaultWorkspace, { recursive: true, force: true });
});

function makeRuntime() {
  return {
    config: {
      loadConfig: () => ({
        plugins: { allow: [], entries: { fabrica: { config: {} } } },
        agents: { defaults: { workspace: defaultWorkspace }, list: [{ id: "main", workspace: tmpDir }] },
      }),
      writeConfigFile: vi.fn(async () => {}),
    },
  } as any;
}

describe("runSetup clean-machine regressions", () => {
  it("passes explicit workspacePath through new-agent setup instead of resolving a stale config entry", async () => {
    mockCreateAgent.mockResolvedValue({ agentId: "fabrica-test", workspacePath: tmpDir });

    const { runSetup } = await import("../../lib/setup/index.js");
    const runtime = makeRuntime();
    const result = await runSetup({
      runtime,
      newAgentName: "fabrica-test",
      workspacePath: tmpDir,
      runCommand: vi.fn(),
    });

    expect(mockCreateAgent).toHaveBeenCalledWith(
      runtime,
      "fabrica-test",
      expect.any(Function),
      undefined,
      tmpDir,
    );
    expect(result.workspacePath).toBe(tmpDir);
  });

  it("writes default role models into a fresh workflow without crashing on plain-object YAML nodes", async () => {
    const { runSetup } = await import("../../lib/setup/index.js");
    const runtime = makeRuntime();

    await runSetup({
      runtime,
      agentId: "main",
      workspacePath: tmpDir,
    });

    const workflowPath = path.join(tmpDir, "fabrica", "workflow.yaml");
    const parsed = YAML.parse(await fs.readFile(workflowPath, "utf-8")) as any;
    expect(parsed.roles).toBeDefined();
    expect(parsed.roles.developer.models.junior).toBeTruthy();
    expect(parsed.roles.reviewer.models.senior).toBeTruthy();
  });
});
