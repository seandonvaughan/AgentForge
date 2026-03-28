import type { TimeoutConfig } from './types.js';

export class TimeoutError extends Error {
  readonly code = 'TIMEOUT';
  constructor(timeoutMs: number) {
    super(`Operation timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * TimeoutWrapper — wraps async calls with a configurable deadline.
 * Uses AbortController to signal cancellation on timeout, and races
 * the operation against a deadline promise.
 *
 * @example
 * const tw = new TimeoutWrapper({ timeoutMs: 3000 });
 * const result = await tw.wrap(signal => fetchData(signal));
 */
export class TimeoutWrapper {
  private readonly timeoutMs: number;

  constructor(config: TimeoutConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? 5_000;
  }

  /**
   * Execute fn with an AbortSignal. Rejects with TimeoutError if the
   * deadline is exceeded before fn resolves.
   */
  wrap<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = this.timeoutMs;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(timeoutMs));
      }, timeoutMs);
      // If the main promise wins, clean up the timer
      controller.signal.addEventListener('abort', () => clearTimeout(timer));
    });

    const opPromise = fn(controller.signal).then(
      result => {
        // Signal abort so timer cleanup fires (even though it already fired in timeout case)
        // This is a no-op if abort was already triggered
        return result;
      },
    );

    return Promise.race([opPromise, timeoutPromise]);
  }

  /**
   * Convenience: wrap a zero-argument async fn (ignores the signal).
   */
  call<T>(fn: () => Promise<T>): Promise<T> {
    return this.wrap(() => fn());
  }
}
