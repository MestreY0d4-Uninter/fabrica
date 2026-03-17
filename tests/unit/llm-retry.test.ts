import { describe, it, expect, vi } from "vitest";
import { withLlmRetry } from "../../lib/intake/lib/llm-retry.js";

describe("withLlmRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withLlmRetry(fn, { maxAttempts: 3, backoff: [10, 20] });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on timeout and succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { statusCode: 503 }))
      .mockResolvedValue("recovered");

    const result = await withLlmRetry(fn, { maxAttempts: 3, backoff: [10, 20] });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on HTTP 400", async () => {
    const fn = vi.fn()
      .mockRejectedValue(Object.assign(new Error("bad request"), { statusCode: 400 }));

    await expect(
      withLlmRetry(fn, { maxAttempts: 3, backoff: [10, 20] }),
    ).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting all retries", async () => {
    const fn = vi.fn()
      .mockRejectedValue(Object.assign(new Error("503"), { statusCode: 503 }));

    await expect(
      withLlmRetry(fn, { maxAttempts: 3, backoff: [10, 10] }),
    ).rejects.toThrow("503");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("tags thrown error with llm_fallback=true on exhaustion", async () => {
    const fn = vi.fn()
      .mockRejectedValue(Object.assign(new Error("503"), { statusCode: 503 }));

    let caughtErr: any;
    try {
      await withLlmRetry(fn, { maxAttempts: 3, backoff: [10, 10] });
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr?.llm_fallback).toBe(true);
  });
});
