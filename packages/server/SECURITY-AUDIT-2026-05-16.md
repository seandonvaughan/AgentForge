# Security Audit — `packages/server/` — 2026-05-16

**Scope:** CORS, auth bypass, path sanitization, `child_process` usage  
**Auditor:** CodeReviewer agent  
**Verdict:** 3 MAJOR findings fixed; 0 CRITICAL; child_process surfaces are safe

---

## Executive Summary

Four attack surfaces were audited across `packages/server/src/`. Three fixable
security issues were found and corrected in this sprint. The `child_process`
surface is clean — all subprocess invocations use `execFile`/`spawn` with array
argument forms (not shell-interpolated strings), and every user-supplied value
is either validated against a strict allowlist or comes from the trusted
workspace registry.

---

## MAJOR Findings (all fixed in this sprint)

### MAJOR-1 — CORS: streaming SSE endpoints exclude `127.0.0.1` origins

**Files fixed:**
- `src/routes/v5/stream.ts` (GET `/api/v5/stream`)
- `src/routes/v5/streaming.ts` (GET `/api/v5/stream/response/:taskId`)
- `src/routes/v5/dashboard-stubs.ts` (GET `/api/v5/memory/stream`)

**What was wrong:**  
The three SSE streaming endpoints call `reply.raw.writeHead()` directly, which
bypasses the Fastify `@fastify/cors` plugin. They manually set
`Access-Control-Allow-Origin` by reflecting the request `Origin` header — but
only when it matched `/^https?:\/\/localhost(:\d+)?$/`. This regex had two
problems:

1. **`127.0.0.1` not covered.** The main CORS plugin (server.ts) allowlists
   `http://127.0.0.1:4751` and `http://127.0.0.1:4752`, but the SSE endpoints
   only reflected `localhost` origins. Any browser navigating to the dashboard
   via `http://127.0.0.1:4751` would fail to establish SSE connections with a
   CORS error.

2. **`https://` allowed unnecessarily.** The server runs HTTP-only (`host:
   127.0.0.1`, no TLS). Reflecting `https://localhost:*` origins widens the
   surface without benefit.

**Fix applied:**  
```diff
- /^https?:\/\/localhost(:\d+)?$/
+ /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/
```
The fallback origin (used when no matching `Origin` header is present) is
unchanged: `http://localhost:4751`.

**Regression test:** `src/__tests__/security-audit.test.ts` — "SSE CORS origin
check" suite (8 assertions).

---

### MAJOR-2 — Auth bypass: `isExcluded` uses pure `startsWith` prefix matching

**File fixed:** `src/lib/auth/plugin.ts`

**What was wrong:**  
```typescript
// Before:
return excludePaths.some((prefix) => path.startsWith(prefix));
```

With `DEFAULT_EXCLUDE_PATHS = ["/api/v5/health"]`, the expression
`"/api/v5/healthdata".startsWith("/api/v5/health")` evaluates to `true`.  Any
future endpoint whose path began with `/api/v5/health` (e.g. `/api/v5/healthcheck`,
`/api/v5/healthdata`) would be silently excluded from authentication, creating
an auth bypass for those routes whenever the OAuth2 hook is enabled.

**Fix applied:**  
```typescript
// After:
export function isExcluded(path: string, excludePaths: string[]): boolean {
  return excludePaths.some(
    (prefix) =>
      path === prefix ||
      path.startsWith(prefix + '/') ||
      path.startsWith(prefix + '?'),
  );
}
```
Now only exact matches and genuine sub-paths (separated by `/` or `?`) are
excluded.

**Regression test:** `src/__tests__/security-audit.test.ts` — "isExcluded"
suite (9 assertions including the bypass case).

---

### MAJOR-3 — Prototype pollution: `deepMerge` in settings.ts

**File fixed:** `src/routes/v5/settings.ts`

**What was wrong:**  
```typescript
// Before:
function deepMerge(target: any, source: any): any {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && ...) {
      target[key] = deepMerge(target[key] ?? {}, source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}
```

The endpoints `PUT /api/v5/settings` and `POST /api/v5/settings/import` accept
arbitrary JSON bodies and pass them through `deepMerge`. When `source` contains
a key named `__proto__`, the expression `target['__proto__']` reads the
prototype via the `[[GetPrototypeOf]]` operation and passes `Object.prototype`
as the `target` argument to the recursive call. The inner call then sets
`Object.prototype[key] = value` for each key in the malicious nested object,
polluting the prototype chain for all objects in the process.

A POST body like `{"__proto__": {"isAdmin": true}}` would inject `isAdmin: true`
into `Object.prototype`, potentially affecting downstream authorization logic
or corrupting JSON serialization behavior. Similarly, `constructor` and
`prototype` keys can reach `Function.prototype`.

This attack is reachable by any process that can make HTTP calls to
`127.0.0.1:4750` — including browser pages loaded from localhost, or any
local process.

**Fix applied:**  
```typescript
const PROTOTYPE_POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    if (PROTOTYPE_POISON_KEYS.has(key)) continue;  // prevent prototype pollution
    // ... rest of merge logic
  }
  return target;
}
```

The `any` types were also replaced with `Record<string, unknown>` to make
unsafe property access visible to the TypeScript compiler.

**Regression test:** `src/__tests__/security-audit.test.ts` — "deepMerge
prototype pollution safety" suite (3 assertions).

---

## child_process — No Issues Found

**Files reviewed:**
- `src/routes/v5/cycles.ts` — `spawn(nodeBin, [cliEntry, 'cycle', 'run'], ...)`
- `src/routes/v5/autonomous-branches.ts` — `execFileAsync('git', [...], ...)`

**Analysis:**

| Call site | Executable | Args form | User-controlled values |
|---|---|---|---|
| cycles.ts:1589 — POST cycle | `process.execPath` (node binary) | Array | None — fixed CLI path |
| cycles.ts:1797 — POST rerun | `process.execPath` | Array | None — fixed CLI path |
| autonomous-branches.ts:32 | `'git'` | Array | None — reads local refs |
| autonomous-branches.ts:43 | `'git'` | Array | Branch names from local refs |
| autonomous-branches.ts:73 | `'git'` | Array | `branchName` — URL param |

All calls use `execFile`/`spawn` with the argument **array** form, not a shell
string. This prevents shell injection regardless of argument content.

User-controlled values reach the subprocess only through:
- **Environment variables** (cycles.ts) — each variable is either a UUID,
  a validated number, or a whitelisted string (`opus`/`sonnet`/`haiku`,
  `low`/`medium`/`high`/`xhigh`/`max`, `'1'`/`'0'`).
- **`branchName` (autonomous-branches.ts)** — validated by `validateBranchName`:
  must match `/^autonomous\/[a-zA-Z0-9._\/-]+$/` AND must not contain `..`.
  Passed as an array element to `execFile` (no shell interpretation).

**Verdict: Clean. No changes required.**

---

## Path Sanitization — No New Issues Found

**Files reviewed:**
- `src/lib/safe-join.ts` — containment utility
- `src/routes/v5/sprints.ts` — `SAFE_VERSION` + `safeJoin`
- `src/routes/v5/cycles.ts` — `SAFE_ID` + `safeJoin`
- `src/routes/v5/agent-crud.ts` — `SAFE_AGENT_ID` + `safeJoin` via `agentFilePath`
- `src/routes/v5/autonomous-branches.ts` — `validateBranchName`

`safeJoin` resolves the path and verifies it starts with `base + sep`, catching
`../` sequences and symlink tricks. The regex guards (`SAFE_VERSION`,
`SAFE_ID`, `SAFE_AGENT_ID`, `BRANCH_NAME_RE`) provide a first layer that
rejects malformed identifiers before they reach `safeJoin`.

**Verdict: Clean. No changes required.**

---

## CORS — Baseline Config (server.ts)

The primary CORS registration uses a strict localhost allowlist:
```typescript
origin: [
  `http://${host}:${port}`,
  'http://localhost:4751',
  'http://localhost:4752',
  'http://127.0.0.1:4751',
  'http://127.0.0.1:4752',
],
credentials: false,
```

This is correct. No wildcard, no credentials. The fix in MAJOR-1 ensures the
SSE endpoints (which bypass the plugin via `writeHead`) apply the same
`127.0.0.1` allowance.

---

## Recommendations (non-blocking)

1. **Add `registerOAuth2Hook` call to server.ts** guarded by an env var (e.g.
   `AGENTFORGE_AUTH_MODE`). This lets operators enable JWT/introspect auth
   without code changes when the server is exposed beyond loopback.
   
2. **Add `reports_to` agent-ID validation** in `agent-crud.ts` to reject values
   that don't match `SAFE_AGENT_ID`. Currently any string is accepted and
   written as a YAML key in `delegation.yaml`.

3. **Consolidate SSE CORS logic** into a shared helper to avoid the three files
   drifting apart again. A `setLocalCorsHeader(req, reply, fallback)` function
   would make future audits cheaper.

---

*Report generated by the CodeReviewer agent, sprint 2026-05-16.*
