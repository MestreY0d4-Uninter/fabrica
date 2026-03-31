import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectForumTopic } from "../../lib/telegram/topic-service.js";

describe("createProjectForumTopic", () => {
  afterEach(() => {
    vi.useRealTimers();
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
});
