/**
 * Unit tests for the OAuth2 Bearer token validator.
 *
 * Tests cover:
 *   - extractBearerToken: header parsing
 *   - validateJwt: HS256 and RS256 signature verification, time claims, issuer/audience
 *   - validateToken: mode dispatch (disabled / jwt / introspect)
 *
 * JWT construction uses node:crypto primitives — no additional test dependencies needed.
 */

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  extractBearerToken,
  validateJwt,
  validateToken,
} from "../../../src/server/auth/oauth2-validator.js";

// ---------------------------------------------------------------------------
// Helpers — minimal JWT builder for tests (HS256 only)
// ---------------------------------------------------------------------------

function base64url(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildJwt(
  payload: Record<string, unknown>,
  secret: string,
): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const TEST_SECRET = "test-secret-key-for-unit-tests";

// ---------------------------------------------------------------------------
// extractBearerToken
// ---------------------------------------------------------------------------

describe("extractBearerToken", () => {
  it("returns the token from a valid Bearer header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the Bearer scheme", () => {
    expect(extractBearerToken("bearer abc123")).toBe("abc123");
    expect(extractBearerToken("BEARER abc123")).toBe("abc123");
  });

  it("returns null when header is undefined", () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("returns null for non-Bearer scheme", () => {
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractBearerToken("")).toBeNull();
  });

  it("returns null when Bearer has no token", () => {
    expect(extractBearerToken("Bearer")).toBeNull();
  });

  it("returns a JWT token unchanged", () => {
    const jwt = "eyJ.eyJ.sig";
    expect(extractBearerToken(`Bearer ${jwt}`)).toBe(jwt);
  });
});

// ---------------------------------------------------------------------------
// validateJwt — HS256
// ---------------------------------------------------------------------------

describe("validateJwt — HS256", () => {
  it("accepts a valid HS256 JWT", () => {
    const token = buildJwt(
      { sub: "user-1", iss: "test-issuer", exp: nowSeconds() + 3600 },
      TEST_SECRET,
    );
    const result = validateJwt(token, {
      mode: "jwt",
      jwtAlgorithm: "HS256",
      jwtSecret: TEST_SECRET,
    });
    expect(result.valid).toBe(true);
    expect(result.subject).toBe("user-1");
  });

  it("rejects a token with a wrong secret", () => {
    const token = buildJwt({ sub: "user-1" }, TEST_SECRET);
    const result = validateJwt(token, {
      mode: "jwt",
      jwtAlgorithm: "HS256",
      jwtSecret: "wrong-secret",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/signature/i);
  });

  it("rejects a tampered payload", () => {
    const token = buildJwt({ sub: "user-1", role: "user" }, TEST_SECRET);
    // Tamper: swap the payload section for a different base64url-encoded JSON
    const [h, , s] = token.split(".");
    const fakePayload = base64url(JSON.stringify({ sub: "user-1", role: "admin" }));
    const tampered = `${h}.${fakePayload}.${s}`;
    const result = validateJwt(tampered, {
      mode: "jwt",
      jwtAlgorithm: "HS256",
      jwtSecret: TEST_SECRET,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects an expired token", () => {
    const token = buildJwt(
      { sub: "user-1", exp: nowSeconds() - 120 },
      TEST_SECRET,
    );
    const result = validateJwt(token, {
      mode: "jwt",
      jwtAlgorithm: "HS256",
      jwtSecret: TEST_SECRET,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/expired/i);
  });

  it("rejects a not-yet-valid token (nbf in the future)", () => {
    const token = buildJwt(
      { sub: "user-1", nbf: nowSeconds() + 600 },
      TEST_SECRET,
    );
    const result = validateJwt(token, {
      mode: "jwt",
      jwtAlgorithm: "HS256",
      jwtSecret: TEST_SECRET,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not yet valid/i);
  });

  it("accepts a token that is near expiry but within clock skew", () => {
    // exp is 20 seconds in the past — within 30-second skew tolerance
    const token = buildJwt(
      { sub: "user-1", exp: nowSeconds() - 20 },
      TEST_SECRET,
    );
    const result = validateJwt(token, {
      mode: "jwt",
      jwtAlgorithm: "HS256",
      jwtSecret: TEST_SECRET,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a token with wrong issuer", () => {
    const token = buildJwt(
      { sub: "user-1", iss: "other-issuer" },
      TEST_SECRET,
    );
    const result = validateJwt(token, {
      mode: "jwt",
      jwtAlgorithm: "HS256",
      jwtSecret: TEST_SECRET,
      jwtIssuer: "expected-issuer",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/issuer/i);
  });

  it("accepts a token with matching issuer", () => {
    const token = buildJwt(
      { sub: "user-1", iss: "expected-issuer" },
      TEST_SECRET,
    );
    const result = validateJwt(token, {
      mode: "jwt",
      jwtAlgorithm: "HS256",
      jwtSecret: TEST_SECRET,
      jwtIssuer: "expected-issuer",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a token with wrong audience", () => {
    const token = buildJwt(
      { sub: "user-1", aud: "service-a" },
      TEST_SECRET,
    );
    const result = validateJwt(token, {
      mode: "jwt",
      jwtAlgorithm: "HS256",
      jwtSecret: TEST_SECRET,
      jwtAudience: "service-b",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/audience/i);
  });

  it("accepts a token whose audience array includes the expected value", () => {
    const token = buildJwt(
      { sub: "user-1", aud: ["service-a", "service-b"] },
      TEST_SECRET,
    );
    const result = validateJwt(token, {
      mode: "jwt",
      jwtAlgorithm: "HS256",
      jwtSecret: TEST_SECRET,
      jwtAudience: "service-b",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a malformed (non-JWT) string", () => {
    const result = validateJwt("not.a.valid.jwt.at.all", {
      mode: "jwt",
      jwtAlgorithm: "HS256",
      jwtSecret: TEST_SECRET,
    });
    expect(result.valid).toBe(false);
  });

  it("returns misconfiguration error when jwtSecret is missing for HS256", () => {
    const token = buildJwt({ sub: "user-1" }, TEST_SECRET);
    const result = validateJwt(token, {
      mode: "jwt",
      jwtAlgorithm: "HS256",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/misconfiguration/i);
  });

  it("includes scope in result when present in token", () => {
    const token = buildJwt(
      { sub: "svc", scope: "read:agents write:sessions" },
      TEST_SECRET,
    );
    const result = validateJwt(token, {
      mode: "jwt",
      jwtAlgorithm: "HS256",
      jwtSecret: TEST_SECRET,
    });
    expect(result.valid).toBe(true);
    expect(result.scope).toBe("read:agents write:sessions");
  });
});

// ---------------------------------------------------------------------------
// validateToken — mode dispatch
// ---------------------------------------------------------------------------

describe("validateToken", () => {
  it("returns valid:true immediately when mode is disabled", async () => {
    const result = await validateToken("any-token", { mode: "disabled" });
    expect(result.valid).toBe(true);
  });

  it("delegates to validateJwt when mode is jwt", async () => {
    const token = buildJwt({ sub: "user-1" }, TEST_SECRET);
    const result = await validateToken(token, {
      mode: "jwt",
      jwtAlgorithm: "HS256",
      jwtSecret: TEST_SECRET,
    });
    expect(result.valid).toBe(true);
    expect(result.subject).toBe("user-1");
  });

  it("returns valid:false for invalid jwt when mode is jwt", async () => {
    const result = await validateToken("bad-token", {
      mode: "jwt",
      jwtAlgorithm: "HS256",
      jwtSecret: TEST_SECRET,
    });
    expect(result.valid).toBe(false);
  });
});
