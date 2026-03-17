import { describe, it, expect, vi } from "vitest";
import { raceWithTimeout, getTickTimeoutCount } from "../../lib/services/heartbeat/index.js";

describe("raceWithTimeout", () => {
  it("returns result when fn completes before timeout", async () => {
    const fn = async () => "ok";
    const onTimeout = vi.fn();
    const result = await raceWithTimeout(fn, 5000, onTimeout);
    expect(result).toBe("ok");
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("returns 'timeout' and calls onTimeout when fn exceeds timeout", async () => {
    const fn = () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 5000));
    const onTimeout = vi.fn();
    const result = await raceWithTimeout(fn, 50, onTimeout);
    expect(result).toBe("timeout");
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("clears timer when fn completes (no leak)", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const fn = async () => "fast";
    await raceWithTimeout(fn, 5000, vi.fn());
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

describe("getTickTimeoutCount", () => {
  it("is exported and returns a number", () => {
    expect(typeof getTickTimeoutCount()).toBe("number");
  });
});
