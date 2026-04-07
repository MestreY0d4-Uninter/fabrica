import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sendToAgent } from "../../lib/dispatch/session.js";

describe("sendToAgent runtime fallback", () => {
  it("falls back to subprocess when runtime.subagent.run is unavailable outside a gateway request", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-send-to-agent-"));
    const runCommand = vi.fn().mockResolvedValue({ stdout: '{"runId":"fallback-run-123"}', stderr: "", code: 0, signal: null, killed: false });

    try {
      const result = await sendToAgent("agent:test:subagent:demo", "do the thing", {
        workspaceDir,
        projectName: "demo",
        projectSlug: "demo",
        issueId: 1,
        role: "developer",
        level: "medior",
        fromLabel: "To Do",
        runCommand: runCommand as any,
        runtime: {
          subagent: {
            run: (() => {
              throw new Error("Plugin runtime subagent methods are only available during a gateway request.");
            }) as any,
          },
        } as any,
      });

      expect(result).toEqual({ method: "subprocess_fallback", runId: "fallback-run-123" });
      expect(runCommand).toHaveBeenCalled();
      expect(runCommand.mock.calls[0][0]).toEqual(
        expect.arrayContaining(["openclaw", "gateway", "call", "agent"]),
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
