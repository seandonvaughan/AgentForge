import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Local Codex authentication state derived purely from the contents of
 * `CODEX_HOME/auth.json` (or `<home>/.codex/auth.json`). No subprocess is
 * spawned — this is the file-based foundation that feeds the provider
 * availability probe and the runtime auto-switch path, and the future
 * AgentForge Cloud goal of mapping local auth into a container.
 */
export type CodexAuthStatus = 'authenticated' | 'expired' | 'missing';

export interface CodexAuthResult {
  status: CodexAuthStatus;
  /** Absolute path to the auth.json that was checked (whether or not it exists). */
  path: string;
  /** Human-readable explanation, surfaced to operators and the switch reason. */
  reason: string;
  /** Which credential form was found, when authenticated/expired. */
  source?: 'api-key' | 'tokens';
  /** OAuth token expiry in epoch milliseconds, when derivable from the token. */
  expiresAt?: number;
}

export interface ResolveCodexAuthOptions {
  /** Injectable clock (epoch ms) for deterministic expiry tests. Defaults to Date.now. */
  now?: () => number;
  /** Override the home directory used when CODEX_HOME is unset. Defaults to os.homedir(). */
  homeDir?: string;
}

interface CodexAuthFile {
  OPENAI_API_KEY?: unknown;
  tokens?: { id_token?: unknown; access_token?: unknown; refresh_token?: unknown } | null;
  last_refresh?: unknown;
}

/**
 * Resolve the path to Codex's auth.json: `$CODEX_HOME/auth.json` when set,
 * otherwise `<homeDir>/.codex/auth.json`.
 */
export function resolveCodexAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveCodexAuthOptions = {},
): string {
  const codexHome = env['CODEX_HOME']?.trim();
  if (codexHome) return join(codexHome, 'auth.json');
  return join(options.homeDir ?? homedir(), '.codex', 'auth.json');
}

/**
 * Determine local Codex auth state from auth.json contents.
 *
 * - `missing`: file absent, unreadable, malformed, or holds no usable credential.
 * - `expired`: an OAuth token whose decoded `exp` claim is at/before `now()`.
 * - `authenticated`: a non-empty `OPENAI_API_KEY`, or an OAuth token that is
 *   present and not provably expired.
 */
export function resolveCodexAuth(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveCodexAuthOptions = {},
): CodexAuthResult {
  const path = resolveCodexAuthPath(env, options);
  const now = options.now ?? Date.now;

  if (!existsSync(path)) {
    return { status: 'missing', path, reason: 'Codex auth.json not found (run: codex login)' };
  }

  let parsed: CodexAuthFile;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as CodexAuthFile;
  } catch {
    return { status: 'missing', path, reason: 'Codex auth.json is malformed' };
  }

  if (typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.trim().length > 0) {
    return { status: 'authenticated', source: 'api-key', path, reason: 'OPENAI_API_KEY present in auth.json' };
  }

  const tokens = parsed.tokens;
  const idToken = typeof tokens?.id_token === 'string' ? tokens.id_token : undefined;
  const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : undefined;
  const refreshToken = typeof tokens?.refresh_token === 'string' ? tokens.refresh_token : undefined;
  // The access_token is the bearer the Codex CLI actually uses; the id_token is
  // identity-only and typically short-lived, so it must NOT gate usability. A
  // present refresh_token lets the CLI transparently mint a fresh access_token,
  // so Codex stays usable even when the stored access_token has lapsed.
  const token = accessToken ?? idToken;

  if (token) {
    const expiresAt = decodeJwtExpMs(token);
    if (expiresAt !== undefined && expiresAt <= now() && !refreshToken) {
      return { status: 'expired', source: 'tokens', path, expiresAt, reason: 'Codex OAuth token has expired (run: codex login)' };
    }
    return {
      status: 'authenticated',
      source: 'tokens',
      path,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      reason: 'Codex OAuth token present',
    };
  }

  return { status: 'missing', path, reason: 'Codex auth.json has no usable credentials' };
}

/** Convenience boolean for callers that only care whether Codex is usable now. */
export function isCodexAuthenticated(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveCodexAuthOptions = {},
): boolean {
  return resolveCodexAuth(env, options).status === 'authenticated';
}

/**
 * Decode a JWT's `exp` claim (seconds) into epoch milliseconds without verifying
 * the signature. Returns undefined when the token is not a decodable JWT or has
 * no numeric `exp`. Uses base64url payload decoding only — no crypto, no network.
 */
function decodeJwtExpMs(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
