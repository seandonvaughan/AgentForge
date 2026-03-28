export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Initial delay in ms. Default: 200 */
  initialDelayMs?: number;
  /** Multiplier for each subsequent delay. Default: 2 (exponential backoff) */
  backoffMultiplier?: number;
  /** Maximum delay cap in ms. Default: 10000 */
  maxDelayMs?: number;
  /** Optional predicate — return true to retry this error, false to rethrow immediately. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

const DEFAULT_OPTS: Required<Omit<RetryOptions, 'shouldRetry'>> = {
  maxAttempts: 3,
  initialDelayMs: 200,
  backoffMultiplier: 2,
  maxDelayMs: 10_000,
};

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a function with exponential backoff retry.
 *
 * @example
 * const result = await withRetry(() => fetchData(), { maxAttempts: 4 });
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { maxAttempts, initialDelayMs, backoffMultiplier, maxDelayMs } = { ...DEFAULT_OPTS, ...opts };
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastError: unknown;
  let delayMs = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts || !shouldRetry(err, attempt)) {
        throw err;
      }
      await delay(Math.min(delayMs, maxDelayMs));
      delayMs = Math.min(delayMs * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * Create a reusable retry wrapper with fixed options.
 *
 * @example
 * const retry = createRetry({ maxAttempts: 5, initialDelayMs: 100 });
 * const result = await retry(() => callAPI());
 */
export function createRetry(opts: RetryOptions = {}) {
  return <T>(fn: () => Promise<T>) => withRetry(fn, opts);
}
