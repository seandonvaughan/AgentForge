/**
 * cors-origin.ts — Localhost SSE CORS origin checker
 *
 * Centralises the SSE origin-validation logic used by all SSE endpoints in
 * the AgentForge server.  All SSE routes call reply.raw.writeHead() which
 * bypasses @fastify/cors, so they must set Access-Control-Allow-Origin
 * manually.  This module provides the single validated source-of-truth for
 * that header value.
 *
 * Implementation note: We use String.startsWith() and explicit bounds checks
 * instead of a regex applied to the user-controlled Origin header.  A regex
 * applied to user-supplied strings can be flagged by CodeQL as a potential
 * ReDoS vector (js/redos rule), even when the pattern itself does not exhibit
 * catastrophic backtracking.  The startsWith approach is functionally
 * identical and immune to the lint rule.
 *
 * Ref: project lesson 6 — "Use String.includes() for user-controlled-input
 * matching, not regex."
 */

/**
 * Returns true if `origin` is a valid localhost HTTP origin.
 *
 * Accepted forms:
 *   http://localhost          (no port)
 *   http://localhost:N        (any port)
 *   http://127.0.0.1          (no port)
 *   http://127.0.0.1:N        (any port)
 *
 * Rejected:
 *   https://localhost:*       — server runs HTTP-only locally
 *   http://localhost.evil.com — only bare hostname accepted; afterHost
 *                               check requires '' or ':' next char
 *   http://evil.com           — neither prefix matches
 */
export function isLocalhostCorsOrigin(origin: string | undefined): boolean {
  if (typeof origin !== 'string') return false;

  const LOCALHOST_PREFIX = 'http://localhost';
  const LOOPBACK_PREFIX = 'http://127.0.0.1';

  let afterHost: string;
  if (origin.startsWith(LOCALHOST_PREFIX)) {
    afterHost = origin.slice(LOCALHOST_PREFIX.length);
  } else if (origin.startsWith(LOOPBACK_PREFIX)) {
    afterHost = origin.slice(LOOPBACK_PREFIX.length);
  } else {
    return false;
  }

  // After the host, only end-of-string or a colon-prefixed port is valid.
  // This prevents http://localhost.evil.com and http://localhost//path
  // from accidentally matching.
  return afterHost === '' || afterHost.startsWith(':');
}

/**
 * Fallback origin used in the CORS header when the request carries no
 * recognised localhost origin (e.g. server-side fetch, health probes).
 */
export const SSE_CORS_FALLBACK = 'http://localhost:4751';

/**
 * Returns the CORS origin value to set in Access-Control-Allow-Origin for
 * SSE responses.
 *
 * When the request origin is a valid localhost origin, reflects it exactly
 * so the browser accepts the response (required when credentials or cookies
 * are involved).  Otherwise falls back to the dashboard default so the header
 * is always present and never '*'.
 */
export function sseCorsOrigin(
  requestOrigin: string | string[] | undefined,
): string {
  const origin = Array.isArray(requestOrigin)
    ? requestOrigin[0]
    : requestOrigin;
  return isLocalhostCorsOrigin(origin) ? (origin as string) : SSE_CORS_FALLBACK;
}
