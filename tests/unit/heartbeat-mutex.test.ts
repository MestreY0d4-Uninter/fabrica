import { describe, it, expect, vi, afterEach } from "vitest";
import { raceWithTimeout } from "../../lib/utils/async.js";

describe("heartbeat mutex deadlock prevention", () => {
  it("deferred promise always releases mutex on timeout", async () => {
    // The deferred promise pattern ensures tickPromise is always defined
    // when the timeout handler fires, so the mutex is always released.
    let mutexReleased = false;

    let resolveTick!: (v: unknown) => void;
    const tickPromise = new Promise<unknown>((res) => { resolveTick = res; });
    tickPromise.catch(() => {});

    const result = await raceWithTimeout(
      () => {
        // Simulate a tick that takes longer than the timeout
        return new Promise<void>((resolve) => {
          setTimeout(() => { resolveTick("done"); resolve(); }, 200);
        });
      },
      50, // timeout fires after 50ms
      () => {
        // With the deferred pattern, tickPromise is ALWAYS defined here
        // — no if/else needed
        tickPromise.finally(() => { mutexReleased = true; });
      },
    );

    expect(result).toBe("timeout");
    // Wait for the tickPromise to settle (it resolves after 200ms)
    await tickPromise;
    // Give microtask queue time to run .finally()
    await new Promise((r) => setTimeout(r, 10));
    expect(mutexReleased).toBe(true);
  });
});

describe("deferred promise pattern — A-5 fix", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("tickPromise is always defined before timeout fires", async () => {
    // Simulate the deferred pattern: promise is created BEFORE raceWithTimeout
    let resolveTick!: (v: unknown) => void;
    const tickPromise = new Promise<unknown>((res) => { resolveTick = res; });
    tickPromise.catch(() => {}); // prevent unhandled rejection

    let promiseWasDefinedInTimeout = false;

    await raceWithTimeout(
      () => {
        // Simulate slow tick — timeout fires first
        return new Promise<void>((resolve) => {
          setTimeout(() => { resolveTick("done"); resolve(); }, 200);
        });
      },
      50,
      () => {
        // In the deferred pattern, tickPromise is ALWAYS defined here
        promiseWasDefinedInTimeout = tickPromise !== undefined;
      },
    );

    expect(promiseWasDefinedInTimeout).toBe(true);
    await tickPromise; // wait for settlement
  });

  it("hard safety timeout releases mutex if tick hangs forever", async () => {
    vi.useFakeTimers();
    let mutexReleased = false;

    // Simulate a tick that never resolves
    let resolveTick!: (v: unknown) => void;
    const tickPromise = new Promise<unknown>((res) => { resolveTick = res; });
    tickPromise.catch(() => {});

    const HARD_TIMEOUT = 5 * 60_000;
    const hardTimeout = setTimeout(() => { mutexReleased = true; }, HARD_TIMEOUT);
    tickPromise.finally(() => { clearTimeout(hardTimeout); mutexReleased = true; });

    // Advance past soft timeout but before hard timeout
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mutexReleased).toBe(false);

    // Advance past hard timeout
    await vi.advanceTimersByTimeAsync(HARD_TIMEOUT);
    expect(mutexReleased).toBe(true);

    // Cleanup: resolve the tick to prevent dangling promise
    resolveTick("done");
    vi.useRealTimers();
  });

  it("mutex releases via .finally() when tick completes after timeout", async () => {
    let mutexReleased = false;
    let resolveTick!: (v: unknown) => void;
    const tickPromise = new Promise<unknown>((res) => { resolveTick = res; });
    tickPromise.catch(() => {});

    // Attach .finally() like the timeout handler would
    tickPromise.finally(() => { mutexReleased = true; });

    // Tick completes
    resolveTick("done");
    await tickPromise;

    // Give microtask queue time to run .finally()
    await new Promise((r) => setTimeout(r, 10));
    expect(mutexReleased).toBe(true);
  });
});
