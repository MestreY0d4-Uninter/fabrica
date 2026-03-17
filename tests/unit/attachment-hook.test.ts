import { describe, expect, it } from "vitest";
import { resolveWorkspaceDir } from "../../lib/dispatch/attachment-hook.js";

describe("resolveWorkspaceDir", () => {
  it("prefers agents.defaults.workspace when configured", () => {
    expect(resolveWorkspaceDir({
      agents: {
        defaults: { workspace: "/tmp/default-workspace" },
        list: [{ id: "main", workspace: "/tmp/agent-workspace" }],
      },
    })).toBe("/tmp/default-workspace");
  });

  it("accepts a single explicitly configured agent workspace", () => {
    expect(resolveWorkspaceDir({
      agents: {
        list: [{ id: "main", workspace: "/tmp/only-workspace" }],
      },
    })).toBe("/tmp/only-workspace");
  });

  it("returns null when multiple agent workspaces are configured without a default", () => {
    expect(resolveWorkspaceDir({
      agents: {
        list: [
          { id: "main", workspace: "/tmp/main-workspace" },
          { id: "reviewer", workspace: "/tmp/reviewer-workspace" },
        ],
      },
    })).toBeNull();
  });

  it("returns null when no workspace is configured", () => {
    expect(resolveWorkspaceDir({ agents: { list: [{ id: "main" }] } })).toBeNull();
  });
});
