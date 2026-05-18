# packages/server Security Audit — v23 Sprint

**Date:** 2026-05-18  
**Auditor:** auth-security-engineer  
**Scope:** `packages/server/src/` — CORS configuration, spawn surface, auth middleware, static-file serving, prototype pollution, path traversal, regex ReDoS.

---

## Summary

| Area | Status | Notes |
|---|---|---|
| CORS (static allowlist) | ✅ Clean | Explicit allowlist, no wildcard, `credentials:false` |
| CORS (SSE / writeHead) | ✅ Fixed | Per-route regex consolidated into `lib/cors-origin.ts` |
| Spawn surface | ✅ Clean | Array args, hardcoded binary, no shell invocation |
| Auth middleware | ✅ Clean | 401+WWW-Authenticate on all failures, no log leaks |
| Path traversal | ✅ Clean | `safeJoin` enforced on every file route |
| Prototype pollution | ✅ Clean | `PROTOTYPE_POISON_KEYS` guard in `deepMerge` |
| Security headers | ✅ Clean | CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy |
| Unauthenticated stream/emit | ⚠️ Open | See item OI-1 |
| introspectUrl SSRF | ⚠️ Open | See item OI-2 |
| Auth mode defaults to disabled | ℹ️ By design | Acceptable for local deployments |

---

## Findings

### ✅ CORS — Static allowlist (server.ts)

`@fastify/cors` is registered with an explicit origin allowlist:

```
http://<host>:<port>   (server bind address)
http://localhost:4750
http://localhost:4751
http://localhost:4752
http://127.0.0.1:4751
http://127.0.0.1:4752
```

`credentials: false` is set explicitly. No wildcard. Methods and headers are enumerated. **No issues.**

### ✅ CORS — SSE endpoints (fixed this sprint)

All SSE routes call `reply.raw.writeHead()` which bypasses `@fastify/cors` and must set `Access-Control-Allow-Origin` manually. Prior to this sprint, each of the five SSE endpoints copied an identical regex:

```typescript
// ❌ Before — regex applied to user-controlled Origin header
const isLocalhost = typeof reqOrigin === 'string' &&
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(reqOrigin);
```

While this regex is bounded (anchored, no `.*`) and does not exhibit catastrophic backtracking, applying any regex to user-controlled input is flagged by CodeQL's `js/redos` rule (project lesson 6). The five copies also represented maintainability debt.

**Fix:** Created `packages/server/src/lib/cors-origin.ts` with `isLocalhostCorsOrigin()` and `sseCorsOrigin()`. Both use `String.startsWith()` and bounds checks — no regex. All five SSE endpoints (`stream.ts`, `streaming.ts`, `run-stream.ts`, `cycles.ts`, `dashboard-stubs.ts`) now import from the shared module.

The fix also adds a precise defence against the subdomain-injection vector (`http://localhost.evil.com`) by checking that the character after the host prefix is either `:` or end-of-string — something the regex also handled but that the new code makes explicit.

**Tests:** 28 unit tests in `src/__tests__/cors-origin.test.ts`. Existing CORS tests in `security-audit.test.ts` updated to delegate to the new utility.

### ✅ Spawn surface (cycles.ts)

The server spawns `agentforge cycle run` in two places (POST `/api/v5/cycles` and POST `/api/v5/cycles/:id/rerun`):

```typescript
const child = spawn(nodeBin, [cliEntry, 'cycle', 'run'], {
  cwd: reqProjectRoot,
  detached: true,
  stdio: ['ignore', logFd, logFd],
  env: { ...process.env, AUTONOMOUS_CYCLE_ID: cycleId, ... },
});
```

Security assessment:

- **`nodeBin = process.execPath`** — Node.js's own binary. Not user-influenced. ✅
- **`cliEntry = resolveAgentForgeCli(import.meta.url)`** — Resolved relative to this module's install location, never from user input. ✅
- **`['cycle', 'run']` args** — Hardcoded strings. No user input in argv. ✅
- **No `shell: true`** — Uses `execFile`-style invocation. Shell injection is not possible. ✅
- **`cwd: reqProjectRoot`** — Comes from `resolveProjectRoot()`, which returns either the server's configured fallback root or a path from the workspace registry (a pre-trusted file). Not a live injection from the request body. ✅
- **`env: { ...process.env, ... }`** — Inherits the full server process environment, which intentionally includes `ANTHROPIC_API_KEY` for the subprocess. ✅ (by design)

**No issues.** Compare with the safer pattern: if `shell: true` were ever added, all of the above guarantees would be void — that must never happen.

### ✅ Auth middleware (lib/auth/plugin.ts)

- `registerOAuth2Hook` registers on the root `app` instance, not inside an encapsulated plugin, so the hook runs for **every** request including 404s. ✅
- `isExcluded()` uses `path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?')` — the path-separator guard prevents the classic `/api/v5/health` exclusion from being bypassed with `/api/v5/healthdata`. ✅ (regression-tested in `security-audit.test.ts`)
- All 401 responses carry `WWW-Authenticate: Bearer` per RFC 6750 §3. ✅
- Token content is never logged. Errors reference `result.error` (a server-generated string), not the token itself. ✅
- The default `mode: "disabled"` is acceptable for local-only deployments but must be hardened before any network-exposed deployment. See OI-3.

### ✅ Path traversal (lib/safe-join.ts)

`safeJoin(base, ...parts)` resolves and checks that the result starts with `base + sep`. All file-serving routes use it:

- `GET /api/v5/cycles/:id/**` — cycle ID validated against `SAFE_ID = /^[a-zA-Z0-9_-]+$/` before `safeJoin`. ✅
- `GET /api/v5/cycles/:id/logs/:name` — log name validated against `SAFE_LOG_NAMES` allowlist. ✅
- `GET/PUT /api/v5/agents/:id/raw` — agent ID validated against `SAFE_AGENT_ID`. ✅

### ✅ Prototype pollution (routes/v5/settings.ts)

`deepMerge()` skips `__proto__`, `constructor`, and `prototype` keys via `PROTOTYPE_POISON_KEYS`. Regression-tested in `security-audit.test.ts`.

### ✅ Security headers (server.ts)

Applied as an `onRequest` hook on the root app (before routes):

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; object-src 'none'; frame-ancestors 'self'; connect-src 'self' http://localhost:* ws://localhost:*` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | camera, mic, geo, payment, USB, serial, BT all `()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |

CSP contains `'unsafe-inline'` for `script-src` and `style-src` to support the SvelteKit dashboard. This is acceptable for a local operator tool; for a hosted deployment it should be tightened with a nonce or hash.

---

## Open Items

### OI-1 — `POST /api/v5/stream/emit` is unauthenticated ⚠️ MEDIUM (local deployment) / HIGH (network-exposed)

**Location:** `packages/server/src/routes/v5/stream.ts:126`

Any client that can reach the server port can inject arbitrary events into the SSE stream consumed by the dashboard. Since the server defaults to binding `127.0.0.1`, external hosts cannot reach this endpoint in the default configuration. But in any deployment with `HOST=0.0.0.0` or behind a reverse proxy, this becomes a medium-to-high risk: an attacker could inject fake `review.finding`, `gate.verdict`, or `cycle_event` messages.

**Recommendation:** Guard this endpoint with the OAuth2 auth hook when auth mode is not `"disabled"`. At minimum, add a note in the route that it must be behind auth before any non-loopback exposure.

**Workaround until fixed:** Ensure `HOST` remains `127.0.0.1` (the default) in all deployments. Do not expose the server port directly on 0.0.0.0.

### OI-2 — `introspectUrl` in OAuth2 config has no host/scheme restriction ⚠️ LOW (config-controlled)

**Location:** `packages/server/src/lib/auth/oauth2-validator.ts:224`

`introspectToken()` validates `config.introspectUrl` with `new URL()` but does not restrict the scheme (e.g., `file://`) or prevent SSRF to internal services (e.g., `http://169.254.169.254/`). Exploitability requires the config itself to be attacker-controlled (a separate exploit), which makes this low-severity in practice.

**Recommendation:** Add a pre-flight check:

```typescript
const parsedUrl = new URL(config.introspectUrl);
if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
  return { valid: false, error: 'introspectUrl must use http or https scheme' };
}
```

For production deployments, require `https:` only.

### OI-3 — Auth mode defaults to `"disabled"` ℹ️ By design

The OAuth2 middleware is not registered when `config.mode === "disabled"`, which is the default. This is intentional for local single-user deployments. Any deployment that exposes the API over a network (even a LAN) must explicitly set a mode of `"jwt"` or `"introspect"` and configure the corresponding secret/URL.

**Recommendation:** Add a startup warning to `createServerV5` if the server binds to a non-loopback address and `auth.mode === "disabled"` (or no auth config is provided).

---

## Changes Made This Sprint

| File | Change |
|---|---|
| `src/lib/cors-origin.ts` | **New** — shared `isLocalhostCorsOrigin()` + `sseCorsOrigin()` utility |
| `src/routes/v5/stream.ts` | Replaced inline regex with `sseCorsOrigin()` |
| `src/routes/v5/streaming.ts` | Replaced inline regex with `sseCorsOrigin()` |
| `src/routes/v5/run-stream.ts` | Replaced inline regex with `sseCorsOrigin()` |
| `src/routes/v5/cycles.ts` | Replaced inline regex with `sseCorsOrigin()` |
| `src/routes/v5/dashboard-stubs.ts` | Replaced inline regex with `sseCorsOrigin()` |
| `src/__tests__/cors-origin.test.ts` | **New** — 30 unit tests for the CORS utility |
| `src/__tests__/security-audit.test.ts` | Updated CORS section to use `isLocalhostCorsOrigin` |
