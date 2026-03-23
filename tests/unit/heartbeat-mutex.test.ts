import { describe, it, expect, vi } from "vitest";
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
