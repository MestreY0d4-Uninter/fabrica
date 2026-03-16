import { describe, it, expect } from "vitest";
import { resolveTopicCreationParams } from "../../scripts/genesis-trigger-telegram.js";

describe("resolveTopicCreationParams", () => {
  it("reads bot token from .env file", () => {
    const result = resolveTopicCreationParams({
      envPath: "/tmp/test.env",
      envContent: "TELEGRAM_BOT_TOKEN=123:abc\n",
      slug: "my-project",
      channelId: "-100123",
    });
    expect(result.botToken).toBe("123:abc");
  });

  it("returns error when .env file is missing", () => {
    const result = resolveTopicCreationParams({
      envPath: "/nonexistent/.env",
      envContent: null,
      slug: "my-project",
      channelId: "-100123",
    });
    expect(result.error).toContain(".env");
  });

  it("returns error when bot token is not found in .env", () => {
    const result = resolveTopicCreationParams({
      envPath: "/tmp/test.env",
      envContent: "OTHER_VAR=foo\n",
      slug: "my-project",
      channelId: "-100123",
    });
    expect(result.error).toContain("TELEGRAM_BOT_TOKEN");
  });

  it("returns error when slug is empty", () => {
    const result = resolveTopicCreationParams({
      envPath: "/tmp/test.env",
      envContent: "TELEGRAM_BOT_TOKEN=123:abc\n",
      slug: "",
      channelId: "-100123",
    });
    expect(result.error).toContain("slug");
  });

  it("returns error when channel ID is empty", () => {
    const result = resolveTopicCreationParams({
      envPath: "/tmp/test.env",
      envContent: "TELEGRAM_BOT_TOKEN=123:abc\n",
      slug: "my-project",
      channelId: "",
    });
    expect(result.error).toContain("channel");
  });

  it("trims whitespace and carriage returns from token", () => {
    const result = resolveTopicCreationParams({
      envPath: "/tmp/test.env",
      envContent: "TELEGRAM_BOT_TOKEN=123:abc\r\n",
      slug: "project",
      channelId: "-100123",
    });
    expect(result.botToken).toBe("123:abc");
  });
});
