import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildMessage, notify } from "../../lib/dispatch/notify.js";
import { DATA_DIR } from "../../lib/setup/constants.js";

async function readAuditEvents(workspaceDir: string): Promise<Array<Record<string, unknown>>> {
  const filePath = path.join(workspaceDir, DATA_DIR, "log", "audit.log");
  const content = await fs.readFile(filePath, "utf-8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("notify", () => {
  it("logs queued, attempt, and sent events with messageThreadId", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-notify-"));
    const calls: Array<{ target: string; message: string; opts: Record<string, unknown> }> = [];
    const runtime = {
      channel: {
        telegram: {
          sendMessageTelegram: async (
            target: string,
            message: string,
            opts: Record<string, unknown>,
          ) => {
            calls.push({ target, message, opts });
          },
        },
      },
    } as any;

    try {
      const ok = await notify(
        {
          type: "issueComplete",
          project: "demo",
          issueId: 7,
          issueUrl: "https://example.com/issues/7",
          issueTitle: "Done",
          prUrl: "https://example.com/pull/7",
        },
        {
          workspaceDir,
          runtime,
          target: {
            channelId: "-100123",
            channel: "telegram",
            messageThreadId: 42,
          },
        },
      );

      expect(ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.opts.messageThreadId).toBe(42);

      const events = await readAuditEvents(workspaceDir);
      expect(events.map((event) => event.event)).toEqual([
        "notify",
        "notify_attempt",
        "notify_sent",
      ]);
      expect(events[0]?.status).toBe("queued");
      expect(events[0]?.messageThreadId).toBe(42);
      expect(events[1]?.messageThreadId).toBe(42);
      expect(events[2]?.messageThreadId).toBe(42);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("passes account and thread id to the CLI fallback when runtime is unavailable", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-notify-cli-"));
    const calls: Array<{ args: string[]; opts?: Record<string, unknown> }> = [];
    const runCommand = async (args: string[], opts?: Record<string, unknown>) => {
      calls.push({ args, opts });
      return {
        stdout: "{}",
        stderr: "",
        code: 0,
        exitCode: 0,
        signal: null,
        killed: false,
        termination: "exit",
      } as any;
    };

    try {
      const ok = await notify(
        {
          type: "workerStart",
          project: "demo",
          issueId: 9,
          issueUrl: "https://example.com/issues/9",
          issueTitle: "Started",
          role: "developer",
          level: "senior",
          sessionAction: "spawn",
        },
        {
          workspaceDir,
          runCommand,
          target: {
            channelId: "-100999",
            channel: "telegram",
            accountId: "acct-1",
            messageThreadId: 77,
          },
        },
      );

      expect(ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toEqual(expect.arrayContaining([
        "--account",
        "acct-1",
        "--thread-id",
        "77",
      ]));
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("passes accountId and thread-id through the CLI fallback when runtime is unavailable", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-notify-cli-"));
    const calls: string[][] = [];

    try {
      const ok = await notify(
        {
          type: "workerComplete",
          project: "demo",
          issueId: 8,
          issueUrl: "https://example.com/issues/8",
          role: "developer",
          result: "done",
        },
        {
          workspaceDir,
          target: {
            channelId: "-100123",
            channel: "telegram",
            accountId: "ops",
            messageThreadId: 99,
          },
          runCommand: async (argv) => {
            calls.push(argv);
            return {
              stdout: "{}",
              stderr: "",
              code: 0,
              exitCode: 0,
              signal: null,
              killed: false,
              termination: "exit",
            } as any;
          },
        },
      );

      expect(ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("--account");
      expect(calls[0]).toContain("ops");
      expect(calls[0]).toContain("--thread-id");
      expect(calls[0]).toContain("99");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("formats a reviewRejected notification with a short rationale", () => {
    const message = buildMessage({
      type: "reviewRejected",
      project: "todo-summary",
      issueId: 1,
      issueUrl: "https://github.com/MestreY0d4-Uninter/todo-summary/issues/1",
      issueTitle: "todo-summary-cli",
      prUrl: "https://github.com/MestreY0d4-Uninter/todo-summary/pull/2",
      summary: "Correctness bug in prefix detection",
    });

    expect(message).toContain("Review rejected");
    expect(message).toContain("Correctness bug in prefix detection");
    expect(message).toContain("Pull Request #2");
  });
});
