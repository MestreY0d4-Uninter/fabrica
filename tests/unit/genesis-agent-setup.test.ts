import { describe, it, expect, vi } from "vitest";
import { ensureGenesisAgent } from "../../lib/setup/agent.js";

/**
 * Mock runtime that simulates config reload after `openclaw agents add`.
 * First loadConfig() returns pre-creation config, subsequent calls return
 * post-creation config (with genesis in agents.list).
 */
function mockRuntime(agents: Array<{ id: string }>, bindings: unknown[] = []) {
  const preConfig = {
    agents: { list: [...agents], defaults: { workspace: "/tmp/ws" } },
    bindings: [...bindings],
    channels: { telegram: { enabled: true } },
  };
  const postConfig = {
    agents: { list: [...agents, { id: "genesis", workspace: "/tmp/ws" }], defaults: { workspace: "/tmp/ws" } },
    bindings: [...bindings],
    channels: { telegram: { enabled: true } },
  };
  let callCount = 0;
  return {
    config: {
      loadConfig: vi.fn(() => callCount++ === 0 ? preConfig : postConfig),
      writeConfigFile: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("ensureGenesisAgent", () => {
  it("creates genesis agent and bindings when only main exists", async () => {
    const runtime = mockRuntime([{ id: "main" }]);
    const rc = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    const result = await ensureGenesisAgent(runtime as any, rc);

    expect(result.created).toBe(true);
    expect(rc).toHaveBeenCalledWith(
      expect.arrayContaining(["openclaw", "agents", "add", "genesis"]),
      expect.any(Object),
    );
  });

  it("skips creation when genesis already exists", async () => {
    const runtime = mockRuntime([{ id: "main" }, { id: "genesis" }]);
    const rc = vi.fn();

    const result = await ensureGenesisAgent(runtime as any, rc);

    expect(result.created).toBe(false);
    expect(rc).not.toHaveBeenCalled();
  });

  it("adds telegram binding for genesis and removes main channel-wide telegram only when forumGroupId is provided", async () => {
    const mainTelegramBinding = { agentId: "main", match: { channel: "telegram" } };
    const runtime = mockRuntime([{ id: "main" }], [mainTelegramBinding]);
    const rc = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    await ensureGenesisAgent(runtime as any, rc, { forumGroupId: "-1003709213169" });

    const writtenConfig = runtime.config.writeConfigFile.mock.calls[0]?.[0];
    const bindings = writtenConfig?.bindings ?? [];

    // Genesis gets channel-wide telegram
    expect(bindings).toContainEqual(
      expect.objectContaining({ agentId: "genesis", match: { channel: "telegram" } }),
    );
    // Main's channel-wide telegram removed when we can replace it with forum-specific binding
    expect(bindings).not.toContainEqual(
      expect.objectContaining({ agentId: "main", match: { channel: "telegram" } }),
    );
    // Main gets group-specific binding
    expect(bindings).toContainEqual(
      expect.objectContaining({
        agentId: "main",
        match: { channel: "telegram", peer: { kind: "group", id: "-1003709213169" } },
      }),
    );
  });

  it("preserves main channel-wide telegram binding when no forumGroupId is provided", async () => {
    const mainTelegramBinding = { agentId: "main", match: { channel: "telegram" } };
    const runtime = mockRuntime([{ id: "main" }], [mainTelegramBinding]);
    const rc = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    await ensureGenesisAgent(runtime as any, rc);

    const writtenConfig = runtime.config.writeConfigFile.mock.calls[0]?.[0];
    const bindings = writtenConfig?.bindings ?? [];

    expect(bindings).toContainEqual(
      expect.objectContaining({ agentId: "genesis", match: { channel: "telegram" } }),
    );
    expect(bindings).toContainEqual(
      expect.objectContaining({ agentId: "main", match: { channel: "telegram" } }),
    );
  });
});
