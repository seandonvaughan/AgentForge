import type { RetryPolicyConfig } from './types.js';

const DEFAULTS: Required<Omit<RetryPolicyConfig, 'shouldRetry'>> = {
  maxAttempts: 3,
  initialDelayMs: 100,
  backoffMultiplier: 2,
  maxDelayMs: 10_000,
  jitterFraction: 0.2,
};

function applyJitter(ms: number, fraction: number): number {
  const jitter = ms * fraction * (Math.random() * 2 - 1); // ±fraction
  return Math.max(0, Math.round(ms + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * RetryPolicy — exponential backoff with jitter and pluggable error filter.
 *
 * @example
 * const policy = new RetryPolicy({ maxAttempts: 5, initialDelayMs: 200 });
 * const result = await policy.execute(() => fetchFromExternalService());
 */
export class RetryPolicy {
  private readonly cfg: Required<Omit<RetryPolicyConfig, 'shouldRetry'>> & Pick<RetryPolicyConfig, 'shouldRetry'>;

  constructor(config: RetryPolicyConfig = {}) {
    this.cfg = { ...DEFAULTS, ...config };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const { maxAttempts, initialDelayMs, backoffMultiplier, maxDelayMs, jitterFraction } = this.cfg;
    const shouldRetry = this.cfg.shouldRetry ?? (() => true);

    let delayMs = initialDelayMs;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt === maxAttempts || !shouldRetry(err, attempt)) {
          throw err;
        }
        const waitMs = applyJitter(Math.min(delayMs, maxDelayMs), jitterFraction);
        await sleep(waitMs);
        delayMs = Math.min(delayMs * backoffMultiplier, maxDelayMs);
      }
    }

    throw lastError;
  }
}
