import { describe, it, expect } from "vitest";
import { raceWithTimeout } from "../../lib/utils/async.js";

describe("bootstrap pipeline timeout", () => {
  it("marks result as timeout when pipeline exceeds limit", async () => {
    let timedOut = false;

    const result = await raceWithTimeout(
      () => new Promise<void>((resolve) => setTimeout(resolve, 500)),
      50,
      () => { timedOut = true; },
    );

    expect(result).toBe("timeout");
    expect(timedOut).toBe(true);
  });

  it("returns pipeline result when it completes within limit", async () => {
    let timedOut = false;

    const result = await raceWithTimeout(
      () => Promise.resolve("done"),
      5000,
      () => { timedOut = true; },
    );

    expect(result).toBe("done");
    expect(timedOut).toBe(false);
  });
});
