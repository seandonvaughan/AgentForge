/**
 * OAuth2 Bearer token validation.
 *
 * Supports two strategies:
 *   1. Stateless JWT validation (HS256 / RS256) using node:crypto — no HTTP call needed.
 *   2. RFC 7662 token introspection — delegates validation to the authorization server.
 *
 * No new npm dependencies. All crypto primitives come from node:crypto.
 */

import { createHmac, createVerify } from "node:crypto";
import type { OAuth2Config, AuthResult, TokenPayload } from "./types.js";

// ---------------------------------------------------------------------------
// Bearer token extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the Bearer token from an Authorization header value.
 *
 * Returns null if the header is absent or not a Bearer scheme.
 */
export function extractBearerToken(
  authorizationHeader: string | undefined,
): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader);
  return match ? (match[1] ?? null) : null;
}

// ---------------------------------------------------------------------------
// JWT validation (stateless)
// ---------------------------------------------------------------------------

/**
 * Decodes a Base64url-encoded string to a UTF-8 string.
 * No padding required — Base64url omits = padding.
 */
function base64urlDecode(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  return Buffer.from(padded, "base64").toString("utf-8");
}

/**
 * Parses a JWT string into its parts without verifying the signature.
 * Returns null if the token is structurally invalid.
 */
function parseJwtParts(token: string): {
  headerB64: string;
  payloadB64: string;
  signingInput: string;
  signature: string;
  payload: TokenPayload;
} | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let payload: TokenPayload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64)) as TokenPayload;
  } catch {
    return null;
  }

  return {
    headerB64,
    payloadB64,
    signingInput: `${headerB64}.${payloadB64}`,
    signature: signatureB64,
    payload,
  };
}

/**
 * Verifies an HS256 (HMAC-SHA256) JWT signature.
 *
 * Uses constant-time comparison to mitigate timing attacks.
 */
function verifyHs256(
  signingInput: string,
  signature: string,
  secret: string,
): boolean {
  const expected = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Verifies an RS256 (RSA-SHA256) JWT signature using a PEM public key.
 */
function verifyRs256(
  signingInput: string,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    const base64Sig = signature.replace(/-/g, "+").replace(/_/g, "/");
    return verifier.verify(publicKey, base64Sig, "base64");
  } catch {
    return false;
  }
}

/**
 * Validates the standard JWT time claims: exp and nbf.
 * Applies a 30-second clock skew tolerance.
 * Returns an AuthResult error on failure, null if claims are valid.
 */
function validateTimeClaims(payload: TokenPayload): AuthResult | null {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const clockSkewSeconds = 30;

  if (
    typeof payload.exp === "number" &&
    nowSeconds > payload.exp + clockSkewSeconds
  ) {
    return { valid: false, error: "Token has expired" };
  }

  if (typeof payload.nbf === "number" && nowSeconds < payload.nbf) {
    return { valid: false, error: "Token is not yet valid" };
  }

  return null;
}

/**
 * Validates a JWT Bearer token against the provided OAuth2 configuration.
 *
 * Steps:
 *   1. Parse JWT structure (header.payload.signature)
 *   2. Verify the cryptographic signature (HS256 or RS256)
 *   3. Validate time claims (exp, nbf)
 *   4. Validate issuer and audience when configured
 */
export function validateJwt(token: string, config: OAuth2Config): AuthResult {
  const algorithm = config.jwtAlgorithm ?? "HS256";

  const parsed = parseJwtParts(token);
  if (!parsed) {
    return { valid: false, error: "Malformed JWT" };
  }

  const { signingInput, signature, payload } = parsed;

  let signatureValid = false;
  if (algorithm === "HS256") {
    if (!config.jwtSecret) {
      return { valid: false, error: "Server misconfiguration: jwtSecret required for HS256" };
    }
    signatureValid = verifyHs256(signingInput, signature, config.jwtSecret);
  } else if (algorithm === "RS256") {
    if (!config.jwtPublicKey) {
      return { valid: false, error: "Server misconfiguration: jwtPublicKey required for RS256" };
    }
    signatureValid = verifyRs256(signingInput, signature, config.jwtPublicKey);
  } else {
    return { valid: false, error: `Unsupported algorithm: ${String(algorithm)}` };
  }

  if (!signatureValid) {
    return { valid: false, error: "Invalid token signature" };
  }

  const timeError = validateTimeClaims(payload);
  if (timeError) return timeError;

  if (config.jwtIssuer && payload.iss !== config.jwtIssuer) {
    return { valid: false, error: `Token issuer mismatch: expected "${config.jwtIssuer}"` };
  }

  if (config.jwtAudience) {
    const aud = Array.isArray(payload.aud)
      ? payload.aud
      : payload.aud !== undefined
        ? [payload.aud]
        : [];
    if (!aud.includes(config.jwtAudience)) {
      return { valid: false, error: `Token audience mismatch: expected "${config.jwtAudience}"` };
    }
  }

  return {
    valid: true,
    subject: payload.sub,
    scope: payload.scope,
  };
}

// ---------------------------------------------------------------------------
// Token introspection (RFC 7662)
// ---------------------------------------------------------------------------

/**
 * Introspects a token via the authorization server's introspect endpoint.
 *
 * Sends a POST with token= in application/x-www-form-urlencoded format.
 * Uses HTTP Basic auth when introspectClientId and introspectClientSecret are set.
 */
export async function introspectToken(
  token: string,
  config: OAuth2Config,
): Promise<AuthResult> {
  if (!config.introspectUrl) {
    return { valid: false, error: "Server misconfiguration: introspectUrl required for introspect mode" };
  }

  // Validate the URL before making any network call
  try {
    new URL(config.introspectUrl);
  } catch {
    return { valid: false, error: `Invalid introspectUrl: ${config.introspectUrl}` };
  }

  const body = `token=${encodeURIComponent(token)}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept": "application/json",
  };

  if (config.introspectClientId) {
    const credentials = Buffer.from(
      `${config.introspectClientId}:${config.introspectClientSecret ?? ""}`,
    ).toString("base64");
    headers["Authorization"] = `Basic ${credentials}`;
  }

  try {
    const response = await fetch(config.introspectUrl, {
      method: "POST",
      headers,
      body,
    });

    if (!response.ok) {
      return { valid: false, error: `Introspection endpoint returned HTTP ${response.status}` };
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (!data["active"]) {
      return { valid: false, error: "Token is not active" };
    }

    return {
      valid: true,
      subject: typeof data["sub"] === "string" ? data["sub"] : undefined,
      scope: typeof data["scope"] === "string" ? data["scope"] : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `Introspection request failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Unified validator
// ---------------------------------------------------------------------------

/**
 * Validates a Bearer token using the strategy specified in config.mode.
 *
 * - "disabled"   — always returns valid (no-op; safe for local deployments)
 * - "jwt"        — synchronous JWT cryptographic verification
 * - "introspect" — async RFC 7662 token introspection
 */
export async function validateToken(
  token: string,
  config: OAuth2Config,
): Promise<AuthResult> {
  switch (config.mode) {
    case "disabled":
      return { valid: true };

    case "jwt":
      return validateJwt(token, config);

    case "introspect":
      return introspectToken(token, config);

    default:
      return { valid: false, error: `Unknown auth mode: ${String(config.mode)}` };
  }
}
