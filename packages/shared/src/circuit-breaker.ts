export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening. Default: 5 */
  failureThreshold?: number;
  /** Milliseconds to wait in OPEN state before trying HALF-OPEN. Default: 60000 */
  resetTimeoutMs?: number;
  /** Number of successes in HALF-OPEN to close again. Default: 2 */
  halfOpenSuccessThreshold?: number;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureAt?: string;
  lastStateChange: string;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private halfOpenSuccesses = 0;
  private lastFailureAt?: string;
  private lastStateChange = new Date().toISOString();
  private openedAt?: number;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenSuccessThreshold: number;

  constructor(private readonly name: string, opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 60_000;
    this.halfOpenSuccessThreshold = opts.halfOpenSuccessThreshold ?? 2;
  }

  /** Execute a function through the circuit breaker. Throws if circuit is OPEN. */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this._maybeTransitionHalfOpen();

    if (this.state === 'open') {
      throw new CircuitOpenError(`Circuit '${this.name}' is OPEN — refusing call`);
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  get currentState(): CircuitState {
    this._maybeTransitionHalfOpen();
    return this.state;
  }

  stats(): CircuitBreakerStats {
    const s: CircuitBreakerStats = {
      state: this.currentState,
      failures: this.failures,
      successes: this.halfOpenSuccesses,
      lastStateChange: this.lastStateChange,
    };
    if (this.lastFailureAt !== undefined) {
      s.lastFailureAt = this.lastFailureAt;
    }
    return s;
  }

  /** Manually reset to closed state. */
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.halfOpenSuccesses = 0;
    this.lastStateChange = new Date().toISOString();
  }

  private _onSuccess(): void {
    if (this.state === 'half-open') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.halfOpenSuccessThreshold) {
        this._transition('closed');
        this.failures = 0;
        this.halfOpenSuccesses = 0;
      }
    } else {
      this.failures = 0;
    }
  }

  private _onFailure(): void {
    this.failures++;
    this.lastFailureAt = new Date().toISOString();

    if (this.state === 'half-open') {
      this._transition('open');
      this.openedAt = Date.now();
      this.halfOpenSuccesses = 0;
    } else if (this.state === 'closed' && this.failures >= this.failureThreshold) {
      this._transition('open');
      this.openedAt = Date.now();
    }
  }

  private _maybeTransitionHalfOpen(): void {
    if (this.state === 'open' && this.openedAt !== undefined) {
      if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
        this._transition('half-open');
        this.halfOpenSuccesses = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any).openedAt = undefined;
      }
    }
  }

  private _transition(next: CircuitState): void {
    this.state = next;
    this.lastStateChange = new Date().toISOString();
  }
}

export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN';
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}
