/**
 * Integration tests for the OAuth2 Fastify plugin.
 *
 * Tests the full request lifecycle: Authorization header → token extraction
 * → validation → 401/200 using app.inject() against a live Fastify instance.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createServer } from "../../../src/server/server.js";

process.env.NODE_ENV = "test";

// ---------------------------------------------------------------------------
// Test JWT builder
// ---------------------------------------------------------------------------

const TEST_SECRET = "plugin-test-secret-key";

function base64url(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildJwt(
  payload: Record<string, unknown>,
  secret: string = TEST_SECRET,
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

// ---------------------------------------------------------------------------
// Suite: auth disabled (default)
// ---------------------------------------------------------------------------

describe("OAuth2 plugin — mode: disabled (default)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const result = await createServer({ port: 4710 });
    app = result.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("allows requests to /api/v1/health without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
  });

  it("allows requests to any API route without a token when auth is disabled", async () => {
    // /api/v1/unknown-route returns 404 (not 401) because auth is off
    const res = await app.inject({ method: "GET", url: "/api/v1/unknown-route" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Not found");
  });
});

// ---------------------------------------------------------------------------
// Suite: auth mode: jwt
// ---------------------------------------------------------------------------

describe("OAuth2 plugin — mode: jwt", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const result = await createServer({
      port: 4711,
      auth: {
        mode: "jwt",
        jwtAlgorithm: "HS256",
        jwtSecret: TEST_SECRET,
      },
    });
    app = result.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("allows unauthenticated access to excluded path /api/v1/health", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/unknown-route" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Unauthorized");
  });

  it("returns 401 when Authorization header is not Bearer scheme", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/unknown-route",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when Bearer token is invalid", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/unknown-route",
      headers: { authorization: "Bearer not-a-valid-jwt" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Unauthorized");
  });

  it("returns 401 when Bearer token is signed with wrong secret", async () => {
    const token = buildJwt({ sub: "user-1", exp: nowSeconds() + 3600 }, "wrong-secret");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/unknown-route",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when Bearer token is expired", async () => {
    const token = buildJwt({ sub: "user-1", exp: nowSeconds() - 120 }, TEST_SECRET);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/unknown-route",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("passes a valid JWT through to the route handler", async () => {
    const token = buildJwt({ sub: "user-1", exp: nowSeconds() + 3600 }, TEST_SECRET);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/unknown-route",
      headers: { authorization: `Bearer ${token}` },
    });
    // 404 means the auth check passed and the route handler ran
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Not found");
  });

  it("returns 401 for unknown API routes without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v2/agents" });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Suite: custom excludePaths
// ---------------------------------------------------------------------------

describe("OAuth2 plugin — custom excludePaths", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const result = await createServer({
      port: 4712,
      auth: {
        mode: "jwt",
        jwtAlgorithm: "HS256",
        jwtSecret: TEST_SECRET,
        excludePaths: ["/api/v1/health", "/api/v1/public"],
      },
    });
    app = result.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("allows unauthenticated access to custom excluded path /api/v1/public", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/public" });
    // No route registered → 404, not 401 — auth was bypassed
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Not found");
  });

  it("still requires auth on non-excluded routes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/sessions" });
    expect(res.statusCode).toBe(401);
  });
});
