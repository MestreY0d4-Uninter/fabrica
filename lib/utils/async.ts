/**
 * utils/async.ts — Shared async utilities.
 */

/**
 * Race a promise against a timeout. Returns "timeout" if the timeout fires first.
 */
export async function raceWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve("timeout");
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    return result;
  } finally {
    clearTimeout(timer!);
  }
}
