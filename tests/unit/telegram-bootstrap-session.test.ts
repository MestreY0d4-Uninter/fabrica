import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanupTelegramBootstrapSession,
  expireTelegramBootstrapSession,
  readTelegramBootstrapSession,
  shouldSuppressTelegramBootstrapReply,
  upsertTelegramBootstrapSession,
} from "../../lib/dispatch/telegram-bootstrap-session.js";

describe("telegram bootstrap session lifecycle", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-telegram-session-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("expires suppression explicitly without deleting the bootstrap session", async () => {
    await upsertTelegramBootstrapSession(workspaceDir, {
      conversationId: "123456",
      rawIdea: "Build a Python CLI called csv-peek",
      sourceRoute: { channel: "telegram", channelId: "123456" },
      status: "classifying",
    });

    const expired = await expireTelegramBootstrapSession(workspaceDir, "123456");

    expect(expired?.conversationId).toBe("telegram:123456");
    expect(shouldSuppressTelegramBootstrapReply(expired)).toBe(false);
    await expect(
      fs.access(path.join(workspaceDir, "fabrica", "bootstrap-sessions", "telegram:123456.json")),
    ).resolves.toBeUndefined();
    expect(await readTelegramBootstrapSession(workspaceDir, "123456")).not.toBeNull();
  });

  it("removes bootstrap sessions only through explicit cleanup", async () => {
    await upsertTelegramBootstrapSession(workspaceDir, {
      conversationId: "123456",
      rawIdea: "Build a Python CLI called csv-peek",
      sourceRoute: { channel: "telegram", channelId: "123456" },
      status: "failed",
    });

    await expect(cleanupTelegramBootstrapSession(workspaceDir, "123456")).resolves.toBe(true);
    await expect(cleanupTelegramBootstrapSession(workspaceDir, "123456")).resolves.toBe(false);
    expect(await readTelegramBootstrapSession(workspaceDir, "123456")).toBeNull();
  });
});
