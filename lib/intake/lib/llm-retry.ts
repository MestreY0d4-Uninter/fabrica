/**
 * intake/lib/llm-retry.ts — Retry wrapper for LLM calls in the pipeline.
 *
 * Retries on: timeout, HTTP 429, HTTP 503
 * Does NOT retry on: HTTP 400, schema/format errors
 */

type LlmError = Error & { statusCode?: number; code?: string };

const NON_RETRYABLE_CODES = new Set([400, 401, 403, 404, 422]);

export type LlmRetryOpts = {
  maxAttempts?: number;
  backoff?: number[];
};

const DEFAULTS: Required<LlmRetryOpts> = {
  maxAttempts: 3,
  backoff: [2_000, 4_000, 8_000],
};

/**
 * Execute fn with retry on transient LLM errors.
 */
export async function withLlmRetry<T>(
  fn: () => Promise<T>,
  opts?: LlmRetryOpts,
): Promise<T> {
  const { maxAttempts, backoff } = { ...DEFAULTS, ...opts };
  let lastErr: unknown;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      const code = (err as LlmError).statusCode;
      if (code !== undefined && NON_RETRYABLE_CODES.has(code)) throw err;
      if (i < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, backoff[i] ?? backoff[backoff.length - 1] ?? 2_000));
      }
    }
  }
  // All retries exhausted — tag the error with llm_fallback flag
  const fallbackErr = lastErr as Error & { llm_fallback?: boolean };
  fallbackErr.llm_fallback = true;
  throw fallbackErr;
}
