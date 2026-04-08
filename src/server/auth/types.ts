/**
 * OAuth2 authentication types for the AgentForge server.
 *
 * The auth module supports two validation strategies:
 *   - "jwt"       — stateless JWT verification (HS256 or RS256) with no external call
 *   - "introspect" — RFC 7662 token introspection against an authorization server
 *   - "disabled"  — no authentication (default; safe for local-only deployments)
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Algorithm used to sign JWTs. Currently HS256 and RS256 are supported. */
export type JwtAlgorithm = "HS256" | "RS256";

/** OAuth2 authentication strategy. */
export type OAuth2Mode = "disabled" | "jwt" | "introspect";

/**
 * Configuration for the OAuth2 auth module.
 *
 * Pass this as `auth` in `ServerOptions` to enable authentication on API routes.
 */
export interface OAuth2Config {
  /**
   * Authentication mode.
   *
   * - "disabled"  — all requests pass through (default)
   * - "jwt"       — validate the Bearer token as a signed JWT
   * - "introspect" — call the authorization server's introspect endpoint
   */
  mode: OAuth2Mode;

  // --- JWT mode options ---

  /**
   * Shared secret for HS256 JWT verification.
   * Required when mode is "jwt" and algorithm is "HS256".
   */
  jwtSecret?: string;

  /**
   * PEM-encoded RSA public key for RS256 JWT verification.
   * Required when mode is "jwt" and algorithm is "RS256".
   */
  jwtPublicKey?: string;

  /** JWT signing algorithm. Defaults to "HS256". */
  jwtAlgorithm?: JwtAlgorithm;

  /**
   * Expected token issuer (`iss` claim).
   * When set, tokens with a different issuer are rejected.
   */
  jwtIssuer?: string;

  /**
   * Expected token audience (`aud` claim).
   * When set, tokens whose audience does not include this value are rejected.
   */
  jwtAudience?: string;

  // --- Introspection mode options ---

  /**
   * Full URL of the RFC 7662 introspection endpoint.
   * Required when mode is "introspect".
   * Example: "https://auth.example.com/oauth2/introspect"
   */
  introspectUrl?: string;

  /** Client ID for authenticating to the introspection endpoint. */
  introspectClientId?: string;

  /** Client secret for authenticating to the introspection endpoint. */
  introspectClientSecret?: string;

  // --- Route exclusions ---

  /**
   * URL path prefixes that bypass authentication.
   * Useful for health checks, docs, or public endpoints.
   * Defaults to ["/api/v1/health"].
   */
  excludePaths?: string[];
}

// ---------------------------------------------------------------------------
// Token payload
// ---------------------------------------------------------------------------

/**
 * Parsed JWT payload or introspection response claims.
 *
 * Standard OAuth2/OIDC claims are typed; additional claims are captured
 * in the index signature.
 */
export interface TokenPayload {
  /** Subject — usually a user or client ID. */
  sub?: string;
  /** Issuer — identifies the authorization server. */
  iss?: string;
  /** Audience — intended recipient(s) of the token. */
  aud?: string | string[];
  /** Expiration time (Unix seconds). */
  exp?: number;
  /** Not-before time (Unix seconds). */
  nbf?: number;
  /** Issued-at time (Unix seconds). */
  iat?: number;
  /** OAuth2 scope string. */
  scope?: string;
  /** Whether the token is currently active (introspection response). */
  active?: boolean;
  /** Arbitrary additional claims. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

/** Result of validating a Bearer token. */
export interface AuthResult {
  /** Whether the token is valid and the request should proceed. */
  valid: boolean;
  /** The authenticated subject, if available. */
  subject?: string;
  /** Space-separated scope string, if provided in the token. */
  scope?: string;
  /** Human-readable error description when `valid` is false. */
  error?: string;
}
