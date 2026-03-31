import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenesisPayload } from "../../lib/intake/index.js";

const { mockRunPipeline } = vi.hoisted(() => ({
  mockRunPipeline: vi.fn(),
}));

vi.mock("../../lib/intake/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/intake/index.js")>();
  return {
    ...actual,
    runPipeline: mockRunPipeline,
  };
});

import { createGenesisTool } from "../../lib/tools/admin/genesis.js";

function makePluginContext() {
  return {
    runCommand: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
    runtime: {} as never,
    pluginConfig: {},
    config: {} as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
  };
}

let tempDirs: string[] = [];

afterEach(async () => {
  mockRunPipeline.mockReset();
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("genesis commit contract", () => {
  it("fails closed when programmatic commit returns no registered project and no runnable work", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-genesis-commit-"));
    tempDirs.push(workspaceDir);

    mockRunPipeline.mockResolvedValue({
      success: true,
      duration_ms: 12,
      steps_executed: ["receive", "classify"],
      steps_skipped: ["register", "create-task", "triage"],
      payload: {
        session_id: "sid-commit-1",
        timestamp: new Date().toISOString(),
        step: "classify",
        raw_idea: "Build a stack cli",
        answers: {},
        metadata: {
          source: "genesis-tool",
          factory_change: false,
          project_registered: false,
        },
      } satisfies GenesisPayload,
    });

    const tool = createGenesisTool(makePluginContext())({ workspaceDir });
    const result = await tool.execute("1", {
      phase: "commit",
      idea: "Build a stack cli",
      dry_run: false,
    });

    expect(result.details.success).toBe(false);
    expect(result.details.error).toContain("no registered project and no runnable work");
  });
});
