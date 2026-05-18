/**
 * Bearer token auth for the MCP server.
 * Token is read from the AGENTFORGE_MCP_TOKEN environment variable.
 * If the env var is not set, auth is disabled (development mode).
 */

export interface AuthResult {
  ok: boolean;
  status: number;
  message: string;
}

/** Extract the bearer token from an Authorization header value. */
export function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return m[1] ?? null;
}

/** Validate the token against AGENTFORGE_MCP_TOKEN. */
export function validateToken(token: string | null): AuthResult {
  const expected = process.env['AGENTFORGE_MCP_TOKEN'];

  // If no token is configured, auth is disabled
  if (!expected) {
    return { ok: true, status: 200, message: 'auth disabled' };
  }

  if (!token) {
    return { ok: false, status: 401, message: 'Missing Authorization header' };
  }

  if (token !== expected) {
    return { ok: false, status: 401, message: 'Invalid bearer token' };
  }

  return { ok: true, status: 200, message: 'ok' };
}
