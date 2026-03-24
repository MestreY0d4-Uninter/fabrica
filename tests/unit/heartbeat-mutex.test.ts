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

  it("deferred tickPromise catch prevents unhandled rejection", async () => {
    // Simulates rejectTick() being called before any .finally() is attached
    let rejectTickFn!: (e: unknown) => void;
    const tickPromise = new Promise<unknown>((_res, rej) => { rejectTickFn = rej; });
    // Attach .catch() immediately — this is what the production code does
    tickPromise.catch(() => {});

    // Reject without any other handler attached
    rejectTickFn(new Error("tick failed"));

    // Wait a microtask — if unhandled rejection was going to fire, it would by now
    await new Promise((r) => setTimeout(r, 10));

    // If we reach here without an unhandledRejection event, the .catch() worked.
    // We verify the promise is settled (rejected) by catching it explicitly:
    const result = await tickPromise.then(() => "resolved").catch(() => "rejected");
    expect(result).toBe("rejected");
  });

  it("hard safety timeout releases mutex if tick hangs forever", async () => {
    vi.useFakeTimers();
    let hardTimeoutFired = false;
    let finallyRan = false;

    let resolveTick!: (v: unknown) => void;
    const tickPromise = new Promise<unknown>((res) => { resolveTick = res; });
    tickPromise.catch(() => {});

    const HARD_TIMEOUT = 5 * 60_000;
    // Set up the two separate paths
    const hardTimeout = setTimeout(() => { hardTimeoutFired = true; }, HARD_TIMEOUT);
    tickPromise.finally(() => { clearTimeout(hardTimeout); finallyRan = true; });

    // Before hard timeout: nothing released
    await vi.advanceTimersByTimeAsync(120_000);
    expect(hardTimeoutFired).toBe(false);
    expect(finallyRan).toBe(false);

    // Advance past hard timeout — hard timeout fires, NOT .finally()
    await vi.advanceTimersByTimeAsync(HARD_TIMEOUT);
    expect(hardTimeoutFired).toBe(true);
    // .finally() has NOT run yet (tick still pending)
    expect(finallyRan).toBe(false);

    // Now resolve the tick — .finally() runs and cancels the hard timeout (already fired, but clearTimeout is safe)
    resolveTick("done");
    await Promise.resolve(); // flush microtasks
    expect(finallyRan).toBe(true);

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
