/**
 * Tests for the OAuth2 onRequest hook (registerOAuth2Hook / oauth2Plugin).
 *
 * These integration-style tests spin up a minimal Fastify instance and verify:
 *   - RFC 6750 §3 compliance: 401 responses MUST carry WWW-Authenticate: Bearer
 *   - Requests with a missing Authorization header receive 401 + header
 *   - Requests with an invalid/expired token receive 401 + header
 *   - Requests with a valid token pass through and populate authContext
 *   - isExcluded correctly gates the allowlist
 *   - config.mode === "disabled" skips the hook entirely
 */

import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { registerOAuth2Hook, isExcluded } from "../../../packages/server/src/lib/auth/plugin.js";
import type { OAuth2Config } from "../../../packages/server/src/lib/auth/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64url(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const SECRET = "test-secret-for-plugin-tests";

async function buildApp(config: OAuth2Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerOAuth2Hook(app, config);
  app.get("/api/v5/protected", async (req, reply) => {
    return reply.send({ ok: true, subject: req.authContext?.subject });
  });
  app.get("/api/v5/health", async (_req, reply) => {
    return reply.send({ status: "ok" });
  });
  // Non-API route — should never be blocked by the auth hook
  app.get("/dashboard", async (_req, reply) => reply.send({ page: true }));
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// isExcluded
// ---------------------------------------------------------------------------

describe("isExcluded", () => {
  it("matches exact path", () => {
    expect(isExcluded("/api/v5/health", ["/api/v5/health"])).toBe(true);
  });

  it("matches sub-path", () => {
    expect(isExcluded("/api/v5/health/live", ["/api/v5/health"])).toBe(true);
  });

  it("matches path with query string", () => {
    expect(isExcluded("/api/v5/health?check=1", ["/api/v5/health"])).toBe(true);
  });

  it("does NOT match a path that merely starts-with the prefix string", () => {
    // '/api/v5/healthdata' must NOT be excluded by '/api/v5/health'
    expect(isExcluded("/api/v5/healthdata", ["/api/v5/health"])).toBe(false);
  });

  it("returns false when list is empty", () => {
    expect(isExcluded("/api/v5/health", [])).toBe(false);
  });

  it("returns false when path not in list", () => {
    expect(isExcluded("/api/v5/protected", ["/api/v5/health"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RFC 6750 §3 — WWW-Authenticate header on 401 responses
// ---------------------------------------------------------------------------

describe("registerOAuth2Hook — WWW-Authenticate compliance (RFC 6750 §3)", () => {
  it("returns 401 with WWW-Authenticate when Authorization header is absent", async () => {
    const app = await buildApp({ mode: "jwt", jwtAlgorithm: "HS256", jwtSecret: SECRET });
    const res = await app.inject({ method: "GET", url: "/api/v5/protected" });

    expect(res.statusCode).toBe(401);
    const wwwAuth = res.headers["www-authenticate"];
    expect(typeof wwwAuth).toBe("string");
    expect(wwwAuth).toMatch(/^Bearer/);
    expect(wwwAuth).toContain('realm="AgentForge"');

    await app.close();
  });

  it("returns 401 with WWW-Authenticate when token signature is invalid", async () => {
    const app = await buildApp({ mode: "jwt", jwtAlgorithm: "HS256", jwtSecret: SECRET });
    const token = buildJwt({ sub: "user-1" }, "wrong-secret");
    const res = await app.inject({
      method: "GET",
      url: "/api/v5/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    const wwwAuth = res.headers["www-authenticate"];
    expect(typeof wwwAuth).toBe("string");
    expect(wwwAuth).toMatch(/^Bearer/);
    // RFC 6750 §3.1 requires error= param on token failures
    expect(wwwAuth).toContain("error=");

    await app.close();
  });

  it("returns 401 with WWW-Authenticate when token is expired", async () => {
    const app = await buildApp({ mode: "jwt", jwtAlgorithm: "HS256", jwtSecret: SECRET });
    const expiredToken = buildJwt({ sub: "user-1", exp: nowSeconds() - 120 }, SECRET);
    const res = await app.inject({
      method: "GET",
      url: "/api/v5/protected",
      headers: { authorization: `Bearer ${expiredToken}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/^Bearer/);

    await app.close();
  });

  it("never returns 403 for missing/invalid tokens — always 401", async () => {
    const app = await buildApp({ mode: "jwt", jwtAlgorithm: "HS256", jwtSecret: SECRET });
    const missingRes = await app.inject({ method: "GET", url: "/api/v5/protected" });
    const badRes = await app.inject({
      method: "GET",
      url: "/api/v5/protected",
      headers: { authorization: "Bearer bad-token" },
    });
    expect(missingRes.statusCode).toBe(401);
    expect(badRes.statusCode).toBe(401);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Successful authentication
// ---------------------------------------------------------------------------

describe("registerOAuth2Hook — successful auth flow", () => {
  it("passes the request through and populates authContext on valid token", async () => {
    const app = await buildApp({ mode: "jwt", jwtAlgorithm: "HS256", jwtSecret: SECRET });
    const token = buildJwt(
      { sub: "svc-account", scope: "read:agents", exp: nowSeconds() + 3600 },
      SECRET,
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/v5/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, subject: "svc-account" });
    expect(res.headers["www-authenticate"]).toBeUndefined();

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Excluded paths bypass the hook
// ---------------------------------------------------------------------------

describe("registerOAuth2Hook — excluded paths", () => {
  it("allows requests to the default health exclusion without a token", async () => {
    const app = await buildApp({ mode: "jwt", jwtAlgorithm: "HS256", jwtSecret: SECRET });
    const res = await app.inject({ method: "GET", url: "/api/v5/health" });
    // Health is in the default exclude list — should pass through without auth
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it("does not block non-API routes (dashboard SPA paths)", async () => {
    const app = await buildApp({ mode: "jwt", jwtAlgorithm: "HS256", jwtSecret: SECRET });
    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Disabled mode
// ---------------------------------------------------------------------------

describe("registerOAuth2Hook — disabled mode", () => {
  it("never blocks requests when mode is disabled", async () => {
    const app = await buildApp({ mode: "disabled" });
    const res = await app.inject({ method: "GET", url: "/api/v5/protected" });
    expect(res.statusCode).toBe(200);

    await app.close();
  });
});
