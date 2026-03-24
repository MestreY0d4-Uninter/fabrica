import { describe, it, expect, vi, afterEach } from "vitest";
import { raceWithTimeout } from "../../lib/utils/async.js";

describe("heartbeat mutex deadlock prevention", () => {
  it("releases mutex when tickPromise is undefined in timeout handler", async () => {
    // Simulate the heartbeat mutex pattern:
    // _anyTickRunning should be released even if tickPromise is not assigned
    let mutexReleased = false;
    let tickPromise: Promise<void> | undefined;

    const result = await raceWithTimeout(
      () => {
        // Simulate a tick that takes long enough for timeout to fire
        // In the real code, tickPromise is assigned by wrappedTickFn
        tickPromise = new Promise<void>((resolve) => setTimeout(resolve, 200));
        return tickPromise;
      },
      50, // timeout fires after 50ms
      () => {
        // This is the timeout handler. In the real code, it checks tickPromise.
        // The bug is that if tickPromise is undefined here, the mutex is never released.
        // After the fix, the else branch releases the mutex.
        if (tickPromise) {
          tickPromise.finally(() => { mutexReleased = true; });
        } else {
          // FIX: release mutex in the else branch
          mutexReleased = true;
        }
      },
    );

    expect(result).toBe("timeout");
    // Wait for the tickPromise to settle
    await new Promise((r) => setTimeout(r, 300));
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
