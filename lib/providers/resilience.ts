/**
 * providers/resilience.ts — Per-provider retry and circuit breaker policies.
 *
 * Each provider (identified by owner/repo) gets its own policy instance.
 * This prevents rate limits on one project from blocking others.
 */
import {
  ExponentialBackoff,
  retry,
  circuitBreaker,
  ConsecutiveBreaker,
  handleAll,
  handleWhen,
  wrap,
  type IPolicy,
} from "cockatiel";

/**
 * Thrown when a GitHub API call receives a rate limit response (429 or 403 with
 * x-ratelimit-remaining: 0). Retried up to MAX_RATE_LIMIT_RETRIES times using
 * the retryAfterMs delay plus jitter to avoid thundering herd.
 */
export class GitHubRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`GitHub rate limit — retry after ${retryAfterMs}ms`);
    this.name = "GitHubRateLimitError";
  }
}

const MAX_RATE_LIMIT_RETRIES = 2;
const JITTER_MAX_MS = 5_000;

const MAX_ENTRIES = 50;
const policyCache = new Map<string, IPolicy>();
const accessOrder: string[] = [];

function createPolicy(): IPolicy {
  const retryableErrors = handleWhen((err) => !(err instanceof GitHubRateLimitError));

  const retryPolicy = retry(retryableErrors, {
    maxAttempts: 3,
    backoff: new ExponentialBackoff({
      initialDelay: 500,
      maxDelay: 10_000,
    }),
  });

  const breakerPolicy = circuitBreaker(handleAll, {
    halfOpenAfter: 30_000,
    breaker: new ConsecutiveBreaker(5),
  });

  return wrap(breakerPolicy, retryPolicy);
}

/**
 * Get or create a resilience policy for a specific provider key (e.g. "owner/repo").
 * Uses LRU eviction when cache exceeds MAX_ENTRIES.
 */
export function getProviderPolicy(providerKey: string): IPolicy {
  const existing = policyCache.get(providerKey);
  if (existing) {
    // Move to end of access order (most recently used)
    const idx = accessOrder.indexOf(providerKey);
    if (idx !== -1) accessOrder.splice(idx, 1);
    accessOrder.push(providerKey);
    return existing;
  }

  // Evict LRU if at capacity
  while (policyCache.size >= MAX_ENTRIES && accessOrder.length > 0) {
    const evictKey = accessOrder.shift()!;
    policyCache.delete(evictKey);
  }

  const policy = createPolicy();
  policyCache.set(providerKey, policy);
  accessOrder.push(providerKey);
  return policy;
}

/**
 * Reset all cached policies (for testing).
 */
export function resetProviderPolicies(): void {
  policyCache.clear();
  accessOrder.length = 0;
}

/**
 * Execute a provider call with per-provider retry + circuit breaker.
 * The providerKey should be the repo identifier (e.g. "owner/repo").
 *
 * Rate-limited requests (GitHubRateLimitError) are retried up to 2 times
 * using the delay from the error plus random jitter (0–5s by default).
 */
export async function withResilience<T>(
  fn: () => Promise<T>,
  providerKey?: string,
  opts?: { jitterMaxMs?: number },
): Promise<T> {
  const policy = providerKey ? getProviderPolicy(providerKey) : getProviderPolicy("__global__");
  const jitterMax = opts?.jitterMaxMs ?? JITTER_MAX_MS;

  // Rate-limit retry layer (inner), then cockatiel policy (outer)
  const withRateLimitRetry = async (): Promise<T> => {
    let lastError: GitHubRateLimitError | undefined;
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof GitHubRateLimitError && attempt < MAX_RATE_LIMIT_RETRIES) {
          lastError = err;
          const jitter = jitterMax > 0 ? Math.floor(Math.random() * jitterMax) : 0;
          await new Promise((resolve) => setTimeout(resolve, err.retryAfterMs + jitter));
          continue;
        }
        throw err;
      }
    }
    throw lastError!;
  };

  return policy.execute(withRateLimitRetry);
}

// Legacy: keep the global singleton export for backward compat during migration
export const providerPolicy: IPolicy = getProviderPolicy("__legacy_global__");
