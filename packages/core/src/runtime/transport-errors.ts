/**
 * Structured error hierarchy for ExecutionTransport implementations.
 *
 * Both AnthropicSdkTransport and ClaudeCodeCompatTransport catch their native
 * errors (Anthropic API errors, spawn errors, CLI exit codes, etc.) and
 * re-throw as one of these subtypes so callers can branch on `retryable` and
 * `instanceof` without inspecting raw message strings.
 */

export class TransportError extends Error {
  /** When true the operation can be retried (e.g. 429, transient network). */
  readonly retryable: boolean;
  /** The underlying raw error (API response, Node.js system error, etc.). */
  readonly cause: unknown;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message);
    this.name = 'TransportError';
    this.retryable = options.retryable;
    this.cause = options.cause;
    // Maintain proper prototype chain under transpiled ES5.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * HTTP 401 / missing API key — credentials are absent or invalid.
 * Not retryable without fixing the key first.
 */
export class TransportAuthError extends TransportError {
  constructor(message: string, cause?: unknown) {
    super(message, { retryable: false, cause });
    this.name = 'TransportAuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The request exceeded the configured or default `timeoutMs` ceiling.
 * May be retried (caller decides whether to extend timeout or give up).
 */
export class TransportTimeoutError extends TransportError {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number, cause?: unknown) {
    super(message, { retryable: true, cause });
    this.name = 'TransportTimeoutError';
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * HTTP 429 / rate-limit — the API is temporarily throttling requests.
 * Retryable after a back-off.
 */
export class TransportRateLimitError extends TransportError {
  constructor(message: string, cause?: unknown) {
    super(message, { retryable: true, cause });
    this.name = 'TransportRateLimitError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * DNS / TCP connection failure, ECONNRESET, ECONNREFUSED, etc.
 * Retryable — the server is likely temporarily unreachable.
 */
export class TransportNetworkError extends TransportError {
  constructor(message: string, cause?: unknown) {
    super(message, { retryable: true, cause });
    this.name = 'TransportNetworkError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * HTTP 400 / invalid model / empty task / malformed request.
 * NOT retryable — the request itself is wrong.
 */
export class TransportInvalidRequestError extends TransportError {
  constructor(message: string, cause?: unknown) {
    super(message, { retryable: false, cause });
    this.name = 'TransportInvalidRequestError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Helper: classify a raw error from the Anthropic SDK or node:child_process
// into the appropriate TransportError subtype.
// ---------------------------------------------------------------------------

interface AnthropicErrorLike {
  status?: number;
  message?: string;
  error?: unknown;
}

function isAnthropicErrorLike(err: unknown): err is AnthropicErrorLike {
  return typeof err === 'object' && err !== null && 'status' in err;
}

/**
 * Convert an arbitrary error thrown by the Anthropic SDK into a structured
 * TransportError subtype.  Pass `cause` through so the original stack is
 * preserved.
 */
export function classifyAnthropicError(err: unknown): TransportError {
  if (err instanceof TransportError) return err;

  if (isAnthropicErrorLike(err)) {
    const status = err.status;
    const message = err.message ?? String(err);

    if (status === 401 || status === 403) {
      return new TransportAuthError(`Anthropic API auth error (${status}): ${message}`, err);
    }
    if (status === 429) {
      return new TransportRateLimitError(`Anthropic API rate-limited (429): ${message}`, err);
    }
    if (status !== undefined && status >= 400 && status < 500) {
      return new TransportInvalidRequestError(
        `Anthropic API bad request (${status}): ${message}`,
        err,
      );
    }
  }

  if (err instanceof Error) {
    const nodeCode = (err as NodeJS.ErrnoException).code;
    if (nodeCode === 'ENOTFOUND' || nodeCode === 'ECONNRESET' || nodeCode === 'ECONNREFUSED') {
      return new TransportNetworkError(`Network error: ${err.message}`, err);
    }
    if (/missing.*api.?key|unauthorized|api key/i.test(err.message)) {
      return new TransportAuthError(err.message, err);
    }
    if (/timed? out/i.test(err.message)) {
      // Timeout without timeoutMs info — use 0 as sentinel.
      return new TransportTimeoutError(err.message, 0, err);
    }
  }

  // Fallback: treat unknown errors as non-retryable invalid requests.
  const message = err instanceof Error ? err.message : String(err);
  return new TransportInvalidRequestError(`Unclassified transport error: ${message}`, err);
}

/**
 * Convert an error from the Claude CLI subprocess into a structured
 * TransportError subtype.
 */
export function classifyCliError(err: unknown, timeoutMs?: number): TransportError {
  if (err instanceof TransportError) return err;

  if (err instanceof Error) {
    const msg = err.message;
    const nodeCode = (err as NodeJS.ErrnoException).code;

    if (nodeCode === 'ENOENT' || /not found|install claude/i.test(msg)) {
      return new TransportInvalidRequestError(
        `Claude CLI not found: ${msg}`,
        err,
      );
    }
    if (/timed? out after/i.test(msg)) {
      return new TransportTimeoutError(msg, timeoutMs ?? 0, err);
    }
    if (/aborted/i.test(msg)) {
      return new TransportTimeoutError(msg, timeoutMs ?? 0, err);
    }
    if (/auth|unauthorized|401|403/i.test(msg)) {
      return new TransportAuthError(msg, err);
    }
    if (/rate.?limit|429/i.test(msg)) {
      return new TransportRateLimitError(msg, err);
    }
    if (nodeCode === 'ENOTFOUND' || nodeCode === 'ECONNRESET' || nodeCode === 'ECONNREFUSED') {
      return new TransportNetworkError(msg, err);
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  return new TransportInvalidRequestError(`CLI transport error: ${message}`, err);
}
