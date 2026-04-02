import { describe, expect, it, vi, beforeEach } from "vitest";

const { auditLogMock, fetchGatewaySessionsMock, isSessionAliveMock, recordIssueLifecycleMock } = vi.hoisted(() => ({
  auditLogMock: vi.fn(async () => {}),
  fetchGatewaySessionsMock: vi.fn(async () => null),
  isSessionAliveMock: vi.fn(() => false),
  recordIssueLifecycleMock: vi.fn(async () => true),
}));

vi.mock("../../lib/audit.js", () => ({
  log: auditLogMock,
}));

vi.mock("../../lib/services/gateway-sessions.js", () => ({
  fetchGatewaySessions: fetchGatewaySessionsMock,
  isSessionAlive: isSessionAliveMock,
}));

vi.mock("../../lib/projects/index.js", () => ({
  recordIssueLifecycle: recordIssueLifecycleMock,
}));

import {
  ensureSessionReady,
  ensureSessionFireAndForget,
  normalizeGatewaySessionLabel,
} from "../../lib/dispatch/session.js";

describe("normalizeGatewaySessionLabel", () => {
  it("returns the label unchanged when it already fits the gateway limit", () => {
    expect(normalizeGatewaySessionLabel("Short Label")).toEqual({
      label: "Short Label",
      fullLabel: "Short Label",
      truncated: false,
    });
  });

  it("truncates labels longer than 64 characters and preserves the full value", () => {
    const fullLabel = "Stack Cli Para Ambientes De Desenvolvimento Reproduziveis Com Nix Flakes - Developer Adrianne (Senior)";
    const normalized = normalizeGatewaySessionLabel(fullLabel);

    expect(normalized.truncated).toBe(true);
    expect(normalized.label).toBeDefined();
    expect(normalized.label!.length).toBeLessThanOrEqual(64);
    expect(normalized.label).toContain("...");
    expect(normalized.fullLabel).toBe(fullLabel);
  });
});

describe("ensureSessionFireAndForget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isSessionAliveMock.mockReturnValue(false);
  });

  it("sends a safe truncated label to sessions.patch and audits the full label", async () => {
    const runCommand = vi.fn(async () => "");
    const fullLabel = "Stack Cli Para Ambientes De Desenvolvimento Reproduziveis Com Nix Flakes - Developer Adrianne (Senior)";

    ensureSessionFireAndForget(
      "session-key",
      "openai/gpt-5",
      "/tmp/workspace",
      runCommand as any,
      30_000,
      fullLabel,
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(runCommand).toHaveBeenCalledTimes(1);
    const [args] = runCommand.mock.calls[0];
    expect(args[2]).toBe("call");
    expect(args[3]).toBe("sessions.patch");
    const params = JSON.parse(args[5]);
    expect(params.label.length).toBeLessThanOrEqual(64);
    expect(params.label).toContain("...");

    expect(auditLogMock).toHaveBeenCalledWith("/tmp/workspace", "session_label_truncated", expect.objectContaining({
      sessionKey: "session-key",
      sessionLabel: params.label,
      sessionLabelFull: fullLabel,
      maxLength: 64,
    }));
  });

  it("records session_patched lifecycle on successful sessions.patch", async () => {
    const runCommand = vi.fn(async () => "");

    ensureSessionFireAndForget(
      "session-key",
      "openai/gpt-5",
      "/tmp/workspace",
      runCommand as any,
      30_000,
      "Short Label",
      { slug: "test-project", issueId: 42 },
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(recordIssueLifecycleMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      slug: "test-project",
      issueId: 42,
      stage: "session_patched",
      sessionKey: "session-key",
    });
  });

  it("includes both short and full labels in the warning audit when sessions.patch fails", async () => {
    const runCommand = vi.fn(async () => {
      throw new Error("label too long");
    });
    const fullLabel = "Stack Cli Para Ambientes De Desenvolvimento Reproduziveis Com Nix Flakes - Developer Adrianne (Senior)";

    ensureSessionFireAndForget(
      "session-key",
      "openai/gpt-5",
      "/tmp/workspace",
      runCommand as any,
      30_000,
      fullLabel,
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(auditLogMock).toHaveBeenCalledWith("/tmp/workspace", "dispatch_warning", expect.objectContaining({
      step: "ensureSession",
      sessionKey: "session-key",
      sessionLabelFull: fullLabel,
      error: "label too long",
    }));
  });
});

describe("ensureSessionReady", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs a warning (does not throw) when the gateway never confirms the session after patching", async () => {
    const runCommand = vi.fn(async () => "");
    fetchGatewaySessionsMock.mockResolvedValue(new Map());

    // P0-3: ensureSessionReady no longer throws — it logs a warning and continues
    await expect(ensureSessionReady(
      "session-key",
      "openai/gpt-5",
      "/tmp/workspace",
      runCommand as any,
      30_000,
      "Short Label",
      { slug: "demo", issueId: 7 },
    )).resolves.toBeUndefined();

    expect(recordIssueLifecycleMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      slug: "demo",
      issueId: 7,
      stage: "session_patched",
      sessionKey: "session-key",
    });
    expect(auditLogMock).toHaveBeenCalledWith("/tmp/workspace", "dispatch_warning", expect.objectContaining({
      step: "confirmSession",
      sessionKey: "session-key",
      error: "gateway_session_not_confirmed",
      note: "dispatch_continues_without_confirmation",
    }));
  });

  it("returns after sessions.patch when the gateway session registry is unavailable", async () => {
    const runCommand = vi.fn(async () => "");
    fetchGatewaySessionsMock.mockResolvedValue(null);

    await expect(ensureSessionReady(
      "session-key",
      "openai/gpt-5",
      "/tmp/workspace",
      runCommand as any,
      30_000,
      "Short Label",
      { slug: "demo", issueId: 7 },
    )).resolves.toBeUndefined();

    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("does not confirm a patched session from a terminal session entry that merely reuses the same key", async () => {
    const runCommand = vi.fn(async () => "");
    const terminalSession = {
      key: "session-key",
      updatedAt: Date.now(),
      percentUsed: 10,
      status: "done",
      endedAt: Date.now() - 1_000,
    };
    fetchGatewaySessionsMock.mockResolvedValue(new Map([["session-key", terminalSession]]));
    isSessionAliveMock.mockReturnValue(false);

    await expect(ensureSessionReady(
      "session-key",
      "openai/gpt-5",
      "/tmp/workspace",
      runCommand as any,
      30_000,
      "Short Label",
      { slug: "demo", issueId: 7 },
    )).resolves.toBeUndefined();

    expect(auditLogMock).toHaveBeenCalledWith("/tmp/workspace", "dispatch_warning", expect.objectContaining({
      step: "confirmSession",
      sessionKey: "session-key",
      error: "gateway_session_not_confirmed",
    }));
  });
});
