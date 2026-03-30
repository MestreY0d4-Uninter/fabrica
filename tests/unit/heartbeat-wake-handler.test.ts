import { describe, it, expect, vi, beforeEach } from "vitest";
import { setPluginWakeHandler, wakeHeartbeat, hasWakeHandler } from "../../lib/services/heartbeat/wake-bridge.js";

describe("heartbeat wake bridge", () => {
  beforeEach(() => {
    setPluginWakeHandler(null);
  });

  it("wakeHeartbeat is no-op when no handler registered", async () => {
    await wakeHeartbeat("test");
    expect(hasWakeHandler()).toBe(false);
  });

  it("wakeHeartbeat calls registered handler with reason", async () => {
    const handler = vi.fn(async () => {});
    setPluginWakeHandler(handler);

    await wakeHeartbeat("work_finish");

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("work_finish");
  });

  it("setPluginWakeHandler(null) unregisters", async () => {
    const handler = vi.fn(async () => {});
    setPluginWakeHandler(handler);
    expect(hasWakeHandler()).toBe(true);

    setPluginWakeHandler(null);
    expect(hasWakeHandler()).toBe(false);

    await wakeHeartbeat("should-noop");
    expect(handler).not.toHaveBeenCalled();
  });
});
