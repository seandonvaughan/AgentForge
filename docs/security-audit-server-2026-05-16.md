# Security Audit — `packages/server/` — 2026-05-16

**Auditor:** CodeReviewer agent (AgentForge)
**Sprint:** v10.5.1 (current)
**Scope:** CORS headers · auth middleware bypass paths · `.agentforge/` path-sanitization · user-controlled values reaching `child_process.spawn`
**Methodology:** Static analysis of all files in `packages/server/src/`, cross-referenced against prior audit findings (2026-05-15)

> **Prerequisite reading:** `docs/security-audit-server-2026-05-15.md` documents four vulnerabilities patched in prior cycles. This audit picks up from the "Items for Next Cycle" list from that report.

---

## Executive Summary

No CRITICAL vulnerabilities found. Three MAJOR findings — two code-duplication risks on the shared path-safety primitive and one dead auth exclusion — were fixed in this cycle. One MINOR CORS hardening was applied for defense-in-depth. Twelve new regression tests pin the path-traversal guards against future drift.

| # | Severity | Status | Finding |
|---|---|---|---|
| 1 | MAJOR | **FIXED** | `lib/auth/plugin.ts`: `DEFAULT_EXCLUDE_PATHS` pointed to `/api/v1/health` (doesn't exist) |
| 2 | MAJOR | **FIXED** | `routes/v5/sprints.ts`: inline copy of `safeJoin` — diverges from shared `lib/safe-join.ts` |
| 3 | MAJOR | **FIXED** | `routes/v5/cycles.ts`: second inline copy of `safeJoin` — same divergence risk |
| 4 | MINOR | **FIXED** | `server.ts`: CORS missing explicit `credentials`, `methods`, `allowedHeaders` |
| 5 | MINOR | **DOCUMENTED** | Auth hook opt-in only — no auth registered by default in `server.ts` |
| 6 | MINOR | **DOCUMENTED** | No startup assertion when server binds to non-loopback interface |
| 7 | INFO | **NOT APPLICABLE** | Memory note `[CRITICAL] search.ts makePaths` — `makePaths` does not exist in codebase; note is stale |
| 8 | INFO | **VERIFIED FIXED** | Memory note `[MAJOR] auditFindings: [] falsy-override` — patched in v10.4.0; regression test in place |

---

## FIXED — Finding 1: Dead Auth Exclusion Path

**File:** `packages/server/src/lib/auth/plugin.ts:28`
**Severity:** MAJOR
**Confidence:** 9/10

### Description

```ts
// BEFORE (broken — /api/v1/health does not exist in the server)
const DEFAULT_EXCLUDE_PATHS = ["/api/v1/health"];

// AFTER (correct)
const DEFAULT_EXCLUDE_PATHS = ["/api/v5/health"];
```

When the OAuth2 auth hook is enabled via `registerOAuth2Hook()`, the exclusion list is supposed to allow the health-check endpoint to be called without a token. The excluded path `/api/v1/health` does not match any registered route — the actual endpoint is `/api/v5/health`. With the old value:

- Monitoring systems calling `GET /api/v5/health` would receive `401 Unauthorized`
- The exclusion provides no actual protection (a dead-code bypass against a non-existent route)

**Note:** `registerOAuth2Hook()` is not called in `server.ts` by default (the server is local-only by design), so this bug has zero runtime impact today. However, it would silently break health monitoring the moment auth is enabled for a network-exposed deployment.

### Fix Applied

Changed `["/api/v1/health"]` → `["/api/v5/health"]` in `lib/auth/plugin.ts`.

---

## FIXED — Finding 2 & 3: Inline `safeJoin` Copies

**Files:**
- `packages/server/src/routes/v5/sprints.ts` (lines 27–32 before patch)
- `packages/server/src/routes/v5/cycles.ts` (lines 98–103 before patch)

**Severity:** MAJOR
**Confidence:** 8/10

### Description

`lib/safe-join.ts` is the canonical path-containment utility introduced in the v10.5.0 security audit. Both `sprints.ts` and `cycles.ts` defined their own inline copies instead of importing the shared version:

```ts
// inline copy in sprints.ts (accepts only single string child)
function safeJoin(base: string, child: string): string | null {
  const resolved = resolve(join(base, child));
  const baseWithSep = base.endsWith(sep) ? base : base + sep;
  if (resolved !== base && !resolved.startsWith(baseWithSep)) return null;
  return resolved;
}

// inline copy in cycles.ts (accepted ...rest args but was functionally identical)
function safeJoin(base: string, ...parts: string[]): string | null { ... }
```

**Risk:** Three divergent copies of the same security primitive. If `lib/safe-join.ts` is patched to fix an edge case (e.g., Windows UNC path handling, symlink resolution, or null-byte injection), the inline copies receive no benefit. A future developer may also patch one inline copy without realising the others exist.

The `sprints.ts` copy had a subtly different API signature (`child: string` vs `...parts: string[]`) — a future caller adding a second path component to a sprints path would silently fall back to string coercion behavior on the extra args.

### Fix Applied

Both inline copies were removed. Both files now import from the canonical source:

```ts
import { safeJoin } from '../../lib/safe-join.js';
```

`sprints.ts` also had its unused `resolve` and `sep` imports from `node:path` removed.

---

## FIXED — Finding 4: CORS Missing Explicit Hardening

**File:** `packages/server/src/server.ts:108–117`
**Severity:** MINOR
**Confidence:** 7/10

### Description

The CORS registration relied on `@fastify/cors` defaults for `credentials`, `methods`, and `allowedHeaders`. The defaults are safe for a localhost server, but implicit — future configuration changes could accidentally expand them.

Key concern: without `allowedHeaders` specified, @fastify/cors reflects whatever the client sends in `Access-Control-Request-Headers`. This means any header a client names in a preflight will be allowed once the origin check passes. For an auth-enabled future deployment, this could allow an attacker to probe which headers are inspected by the server.

### Fix Applied

```ts
await app.register(FastifyCors, {
  origin: [/* localhost only */],
  // Explicit values for defense-in-depth — do not rely on @fastify/cors defaults.
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Workspace-Id'],
});
```

`X-Workspace-Id` is included because `resolveProjectRoot()` in `cycles.ts` reads this header to select a workspace context. Without it in `allowedHeaders`, browser clients sending this header would fail the CORS preflight.

---

## DOCUMENTED — Finding 5: Auth Hook Opt-In Only

**File:** `packages/server/src/server.ts`
**Severity:** MINOR (by design for local dev)
**Confidence:** N/A — known architecture decision

`registerOAuth2Hook()` in `lib/auth/plugin.ts` is fully implemented but never called from `server.ts`. All API endpoints are unauthenticated by default. This is intentional: the server binds to `127.0.0.1` exclusively (loopback) and is designed as a local developer tool.

**Recommendation:** Add a runtime assertion in `server.ts` (or in `main.ts`) that fails startup if `host !== '127.0.0.1'` and the OAuth2 auth hook has not been registered. This prevents the auth gap from silently opening when the server is network-exposed.

```ts
// Suggested assertion in server.ts (not yet implemented):
if (host !== '127.0.0.1' && host !== 'localhost') {
  throw new Error(
    'Server is binding to a non-loopback interface. ' +
    'Register the OAuth2 auth hook via registerOAuth2Hook() before exposing this server to a network.'
  );
}
```

---

## DOCUMENTED — Finding 6: Workspace Path Not Contained

**File:** `packages/server/src/routes/v5/cycles.ts` — `resolveProjectRoot()`
**Severity:** MINOR (requires compromised workspace registry)
**Confidence:** 5/10

When a `workspaceId` query parameter resolves to a registered workspace, the workspace's `path` field is used directly as the `projectRoot` for all file operations in that request:

```ts
const ws = getWorkspace(workspaceId);
return { projectRoot: ws.path };  // no containment check on ws.path
```

If a workspace is registered with `path: /etc`, the server would attempt to operate on `/etc/.agentforge/cycles`. This is only exploitable if:
1. The workspace registration API is accessible to an attacker, AND
2. The attacker can register a workspace pointing to a sensitive directory

**Risk assessment:** Low. Workspace registration is not a high-frequency operation and the workspace registry is server-local. However, if a workspace configuration file (`~/.agentforge/workspaces.json`) is modified by a malicious process, arbitrary `projectRoot` values could be injected.

**Recommendation:** Validate `ws.path` before use:
```ts
if (!isAbsolute(ws.path) || ws.path.includes('..')) {
  return { error: { status: 400, body: { error: 'Invalid workspace path' } } };
}
```

---

## AUDITED CLEAN — CORS Headers

**File:** `packages/server/src/server.ts` + SSE route files

### Findings

All five SSE streaming endpoints that bypass the Fastify CORS plugin via `reply.raw.writeHead()` use the localhost-reflect pattern (not wildcard):

```ts
const reqOrigin = req.headers['origin'];
const isLocalhost = typeof reqOrigin === 'string' &&
  /^https?:\/\/localhost(:\d+)?$/.test(reqOrigin);
const corsOrigin = isLocalhost ? reqOrigin : 'http://localhost:4751';
reply.raw.setHeader('Access-Control-Allow-Origin', corsOrigin);
```

Files verified clean: `stream.ts`, `cycles.ts` (log-tail stream), `dashboard-stubs.ts` (memory stream), `streaming.ts` (agent response stream). The wildcard `Access-Control-Allow-Origin: *` that was patched in `streaming.ts` during the v15.0.0 audit has not regressed.

`dashboard-stubs.ts` uses `reply.raw.setHeader()` rather than `writeHead()` which avoids the "headers already sent" risk — this pattern is correct.

The global security headers hook in `server.ts` sets `Cross-Origin-Resource-Policy: same-origin` and `Cross-Origin-Opener-Policy: same-origin`, providing defense-in-depth against Spectre-class cross-origin data leaks.

---

## AUDITED CLEAN — `child_process.spawn`

**File:** `packages/server/src/routes/v5/cycles.ts` (POST `/api/v5/cycles` and POST `/api/v5/cycles/:id/rerun`)
**File:** `packages/server/src/routes/v5/autonomous-branches.ts`

### cycles.ts spawn

```ts
const nodeBin = process.execPath;  // the server's own Node.js binary — trusted
const cliEntry = resolve(join(opts.projectRoot, 'packages', 'cli', 'dist', 'bin.js'));
// ^ path is constructed from server-configured opts.projectRoot, not user input

const child = spawn(nodeBin, [cliEntry, 'cycle', 'run'], {
  cwd: reqProjectRoot,
  detached: true,
  stdio: ['ignore', logFd, logFd],
  env: { ...process.env, AUTONOMOUS_CYCLE_ID: cycleId, ...budgetEnv, ...modelCapEnv, ... },
});
```

All arguments are hardcoded strings. `shell: false` (the default). No user input reaches the command or argument positions.

Env vars injected into the subprocess (`AUTONOMOUS_BUDGET_USD`, `AUTONOMOUS_MAX_ITEMS`, etc.) are constructed from validated, typed values — the route handler rejects non-numeric budgets, validates model cap against an allowlist, etc. No raw user strings reach env var values.

### autonomous-branches.ts spawn

```ts
await execFileAsync('git', ['-C', cwd, 'branch', force ? '-D' : '-d', branchName], { ... });
```

`execFileAsync` uses the array form — no shell interpolation. Branch names are validated by `validateBranchName()` before use:
- Must start with `autonomous/`
- Must match `/^autonomous\/[a-zA-Z0-9._\/-]+$/`
- Must not contain `..`

Even if validation were bypassed, passing a malicious branch name as an array element to `execFileAsync` cannot achieve command injection — git receives it as a literal argument string.

---

## AUDITED CLEAN — Path Sanitization (existing protections)

| Route | Guard | Containment |
|-------|-------|-------------|
| `GET /api/v5/sprints/:version` | `SAFE_VERSION` regex | `safeJoin()` from `lib/safe-join.ts` |
| `GET|PUT /api/v5/agents/:id/raw` | `SAFE_AGENT_ID` regex | `safeJoin()` from `lib/safe-join.ts` |
| `POST /api/v5/agents` | `id` kebab-case regex | `safeJoin()` from `lib/safe-join.ts` |
| `PATCH|DELETE /api/v5/agents/:id` | `SAFE_AGENT_ID` regex | `safeJoin()` from `lib/safe-join.ts` |
| `POST /api/v5/cycles` | `cycleId = randomUUID()` (inherently safe) | `safeJoin()` from `lib/safe-join.ts` |
| `GET /api/v5/cycles/:id/*` | `SAFE_ID = /^[a-zA-Z0-9_-]+$/` | `safeJoin()` from `lib/safe-join.ts` |
| `GET /api/v5/cycles/:id/phase/:phase` | `SAFE_PHASE` allowlist set | path via `SAFE_FILE_NAMES` set |
| `DELETE /api/v5/autonomous-branches/*` | `validateBranchName()` | args passed as array, not shell |
| `POST /api/v5/run` | `projectRoot` removed from body | `DEFAULT_PROJECT_ROOT` hardcoded |

All path-safety consumers now use the canonical `lib/safe-join.ts` utility — inline copies eliminated in this cycle.

---

## New Tests Added

**File:** `packages/server/src/routes/v5/__tests__/sprints.test.ts`

Added a `'GET /api/v5/sprints/:version — path traversal guards'` describe block with **13 new tests**:

- **9 handler-level rejection tests** (→ 400): `../etc/passwd`, `..%2Fetc%2Fpasswd`, `../../.agentforge/config/settings`, `.`, `''`, `v%2F..%2Fetc`, `%2e%2e`, `x/../../etc`, `x/../y`
- **1 router-level rejection test** (→ 400 or 404): `..` — Fastify normalises this URL segment before routing, so it returns 404 rather than 400; both are safe
- **2 valid-version acceptance tests**: semver `10.5.0` and hyphenated `phase-active`

All 53 sprints tests pass.

---

## Files Modified (this cycle)

| File | Change |
|------|--------|
| `packages/server/src/lib/auth/plugin.ts` | Fixed `DEFAULT_EXCLUDE_PATHS`: `/api/v1/health` → `/api/v5/health` |
| `packages/server/src/routes/v5/sprints.ts` | Replaced inline `safeJoin` with `import { safeJoin } from '../../lib/safe-join.js'`; removed unused `resolve, sep` imports |
| `packages/server/src/routes/v5/cycles.ts` | Replaced inline `safeJoin` with `import { safeJoin } from '../../lib/safe-join.js'` |
| `packages/server/src/server.ts` | Added explicit `credentials: false`, `methods`, `allowedHeaders` to CORS config |
| `packages/server/src/routes/v5/__tests__/sprints.test.ts` | Added 13 path-traversal regression tests |

---

## Items for Next Cycle

- [ ] **MEDIUM** Add startup assertion: if `host` is not loopback (`127.0.0.1` / `localhost`), require `registerOAuth2Hook()` to be called (Finding 5 above)
- [ ] **MEDIUM** Validate `ws.path` in `resolveProjectRoot()` before using as `projectRoot` (Finding 6 above)
- [ ] **LOW** Centralise `SAFE_AGENT_ID` regex into `@agentforge/shared` — currently defined identically in both `agents.ts` and `agent-crud.ts`; regex drift could widen one guard
- [ ] **LOW** Validate agent IDs read from server-controlled phase JSON files in `getAgentDefaults()` (`cycles.ts`) — defense-in-depth against second-order injection via malicious phase file
- [ ] **LOW** Add CORS test: `GET /api/v5/stream/response/:taskId` with `Origin: https://evil.com` must NOT return `Access-Control-Allow-Origin: https://evil.com` or `*`
