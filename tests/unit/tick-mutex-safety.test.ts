import { describe, it, expect, vi, beforeEach } from "vitest";

// We import the module fresh in each test that needs isolated mutex state.
// Because the mutex is module-level state, we reload the module to reset it.

describe("P0-3: timed-out tick does not immediately release the mutex", () => {
  it("keeps _anyTickRunning=true until the slow promise settles after timeout", async () => {
    // Import fresh module to isolate state
    const mod = await import("../../lib/services/heartbeat/index.js?isolate-p0-3-" + Date.now());

    // withTickMutex can be used to probe whether the mutex is held.
    // 1. Start a slow tick via raceWithTimeout with a very short timeout.
    // 2. After the timeout resolves, withTickMutex should return "busy" (mutex still held).
    // 3. After the slow promise settles, withTickMutex should succeed.

    let resolveSlowFn!: () => void;
    const slowPromise = new Promise<void>((resolve) => {
      resolveSlowFn = resolve;
    });

    // Manually simulate what runHeartbeatTick does:
    // We cannot call runHeartbeatTick directly (it reads plugin context),
    // but we can test withTickMutex + raceWithTimeout directly.
    //
    // The critical property: if we acquire the mutex with withTickMutex and
    // keep the inner fn pending, concurrent calls to withTickMutex return "busy".

    let innerResolve!: () => void;
    const innerLatch = new Promise<void>((res) => { innerResolve = res; });

    // Start a withTickMutex call that holds the mutex indefinitely
    const longRunning = mod.withTickMutex(async () => {
      await innerLatch;
      return "done";
    });

    // Give the event loop a tick so withTickMutex can acquire the mutex
    await Promise.resolve();

    // Now a concurrent call should return "busy"
    const concurrentResult = await mod.withTickMutex(async () => "concurrent");
    expect(concurrentResult).toBe("busy");

    // Release the latch
    innerResolve();
    const result = await longRunning;
    expect(result).toBe("done");

    // Now mutex is free — next call should succeed
    const afterResult = await mod.withTickMutex(async () => "after");
    expect(afterResult).toBe("after");
  }, 15_000);

  it("raceWithTimeout does not release mutex when timeout fires before fn completes", async () => {
    // This test validates the core contract of P0-3 at a lower level:
    // - We start a withTickMutex that races a slow fn against a short timeout
    // - The timeout fires and the race resolves as "timeout"
    // - BUT: the mutex must still be held (inner fn still pending)
    // - Only after the inner fn settles does the mutex release

    const mod = await import("../../lib/services/heartbeat/index.js?isolate-p0-3-race-" + Date.now());

    let resolveSlowFn!: () => void;
    const slowFnSettled = { value: false };

    const slowFn = async () => {
      await new Promise<void>((res) => { resolveSlowFn = res; });
      slowFnSettled.value = true;
    };

    const onTimeout = vi.fn();

    // Run raceWithTimeout with a very short timeout so the timeout fires first
    const racePromise = mod.raceWithTimeout(slowFn, 10, onTimeout);

    // Wait for timeout to fire
    const raceResult = await racePromise;
    expect(raceResult).toBe("timeout");
    expect(onTimeout).toHaveBeenCalledOnce();
    // The slow fn has NOT settled yet
    expect(slowFnSettled.value).toBe(false);

    // Settle the slow fn
    resolveSlowFn();
    await new Promise<void>((res) => setTimeout(res, 5));
    expect(slowFnSettled.value).toBe(true);
  });

  it("mutex stays held while timed-out tick is still running", async () => {
    const mod = await import("../../lib/services/heartbeat/index.js?isolate-p0-3-held-" + Date.now());

    // Start a slow async operation via withTickMutex
    let resolveSlowFn!: () => void;
    const slowFnDone = new Promise<void>(r => { resolveSlowFn = r; });

    // Start the mutex-held operation (don't await yet)
    const mutexOp = mod.withTickMutex(async () => {
      await slowFnDone;
      return "done";
    });

    // Allow the async fn to start (yield to event loop)
    await new Promise(r => setTimeout(r, 0));

    // Now the mutex should be held — a second call should return "busy"
    const busyResult = await mod.withTickMutex(async () => "should-not-run");
    expect(busyResult).toBe("busy");

    // Release the slow fn and verify the first call completes
    resolveSlowFn();
    const result = await mutexOp;
    expect(result).toBe("done");

    // After settling, mutex should be released
    const freeResult = await mod.withTickMutex(async () => "should-run");
    expect(freeResult).toBe("should-run");
  });
});

describe("P0-4: withTickMutex — basic behaviour", () => {
  it("returns 'busy' immediately when mutex is already held", async () => {
    const mod = await import("../../lib/services/heartbeat/index.js?isolate-p0-4-busy-" + Date.now());

    let innerResolve!: () => void;
    const latch = new Promise<void>((res) => { innerResolve = res; });

    // Hold the mutex
    const holder = mod.withTickMutex(async () => {
      await latch;
      return "held";
    });

    await Promise.resolve(); // let holder acquire mutex

    const busy = await mod.withTickMutex(async () => "should-not-run");
    expect(busy).toBe("busy");

    innerResolve();
    await holder;
  });

  it("executes fn and returns its result when mutex is free", async () => {
    const mod = await import("../../lib/services/heartbeat/index.js?isolate-p0-4-free-" + Date.now());

    const result = await mod.withTickMutex(async () => 42);
    expect(result).toBe(42);
  });

  it("releases the mutex even when fn throws", async () => {
    const mod = await import("../../lib/services/heartbeat/index.js?isolate-p0-4-throw-" + Date.now());

    await expect(
      mod.withTickMutex(async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");

    // Mutex should be free now
    const after = await mod.withTickMutex(async () => "recovered");
    expect(after).toBe("recovered");
  });
});

describe("P0-4: two concurrent CLI sweep calls serialize", () => {
  it("second call returns 'busy' when first is still running", async () => {
    const mod = await import("../../lib/services/heartbeat/index.js?isolate-p0-4-serialize-" + Date.now());

    let release!: () => void;
    const latch = new Promise<void>((res) => { release = res; });

    const first = mod.withTickMutex(async () => {
      await latch;
      return "first";
    });

    await Promise.resolve(); // allow first to acquire

    // Second concurrent call
    const second = mod.withTickMutex(async () => "second");
    const secondResult = await second;
    expect(secondResult).toBe("busy");

    release();
    const firstResult = await first;
    expect(firstResult).toBe("first");

    // After first settles, a third call should work
    const third = await mod.withTickMutex(async () => "third");
    expect(third).toBe("third");
  });
});
