import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectForumTopic } from "../../lib/telegram/topic-service.js";

describe("createProjectForumTopic", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("throws after retry exhaustion instead of falling back to the general topic", async () => {
    vi.useFakeTimers();
    const handleAction = vi.fn().mockRejectedValue(new Error("topic create failed"));

    const promise = createProjectForumTopic({
      runtime: {
        channel: {
          telegram: {
            messageActions: {
              handleAction,
            },
          },
        },
      } as any,
      config: {} as any,
    }, {
      chatId: "-1003709213169",
      name: "demo-topic",
    });
    const rejection = expect(promise).rejects.toThrow("topic create failed");

    await vi.runAllTimersAsync();

    await rejection;
    expect(handleAction).toHaveBeenCalledTimes(3);
  });

  it("falls back to direct Telegram Bot API when runtime messageActions are unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          message_thread_id: 777,
          name: "demo-topic",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";

    const result = await createProjectForumTopic({
      runtime: {
        channel: {
          telegram: {},
        },
      } as any,
      config: {} as any,
    }, {
      chatId: "-1003709213169",
      name: "demo-topic",
    });

    expect(result).toEqual({
      chatId: "-1003709213169",
      topicId: 777,
      name: "demo-topic",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.telegram.org/bot123:abc/createForumTopic");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        chat_id: "-1003709213169",
        name: "demo-topic",
      }),
    }));
  });

  it("falls back to direct Telegram Bot API when runtime topic-create fails structurally", async () => {
    const handleAction = vi.fn().mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'messageActions')"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          message_thread_id: 778,
          name: "demo-topic",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";

    const result = await createProjectForumTopic({
      runtime: {
        channel: {
          telegram: {
            messageActions: {
              handleAction,
            },
          },
        },
      } as any,
      config: {} as any,
    }, {
      chatId: "-1003709213169",
      name: "demo-topic",
    });

    expect(handleAction).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.topicId).toBe(778);
  });

  it("does not bypass real runtime topic-create failures", async () => {
    const handleAction = vi.fn().mockRejectedValue(new Error("Telegram createForumTopic is disabled."));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";

    await expect(createProjectForumTopic({
      runtime: {
        channel: {
          telegram: {
            messageActions: {
              handleAction,
            },
          },
        },
      } as any,
      config: {} as any,
    }, {
      chatId: "-1003709213169",
      name: "demo-topic",
    })).rejects.toThrow("Telegram createForumTopic is disabled.");

    expect(handleAction).toHaveBeenCalledTimes(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
