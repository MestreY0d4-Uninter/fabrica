import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setPluginWakeHandler, wakeHeartbeat, hasWakeHandler } from "../../lib/services/heartbeat/wake-bridge.js";

describe("heartbeat wake bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setPluginWakeHandler(null);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("coalesces duplicate wake requests inside a short cooldown window", async () => {
    const handler = vi.fn(async () => {});
    setPluginWakeHandler(handler);

    await wakeHeartbeat("reviewer_reject_retriage");
    await wakeHeartbeat("agent_end");
    await wakeHeartbeat("subagent_ended");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("reviewer_reject_retriage");

    vi.advanceTimersByTime(2_100);
    await wakeHeartbeat("agent_end");

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith("agent_end");
  });
});
