# ADR 0002 — Mount new routes under `/api/v6` (existing namespace)

**Status:** Accepted
**Date:** 2026-05-15

## Context

DMs, inbox, and KBs introduce ~25 new HTTP routes. The current API exposes both `/api/v5/*` (see `packages/server/src/routes/v5/index.ts:48`) and `/api/v6/*` (see `packages/server/src/routes/v6/index.ts`). v6 is currently a "strict superset of v5" — it re-exposes every v5 route under `/api/v6/` plus consolidates the v1 lifecycle routes (teams, careers, hiring-recommendations). We must decide whether to extend v5, extend v6, or open a v7 namespace for this wave.

## Decision drivers

- Backwards compatibility: dashboards and CLI clients pinned to v5 should not break.
- Discoverability: callers should be able to tell from the path which feature wave a route belongs to.
- Cost of versioning: not free — adds a directory, a route registration block, mental load.

## Options considered

### Option A — Extend `/api/v5` with new files

Add `dms.ts`, `inbox.ts`, `kbs.ts` to `packages/server/src/routes/v5/`. Register via `index.ts`.

- Pro: zero overhead. Existing dashboards keep working.
- Con: muddies the meaning of "v5." v5 currently means "the workspace-adapter-aware route family that shipped in v5.x of the product." Adding entirely new subsystems blurs that signal.
- Con: when a v5 route's shape needs to change, harder to argue for breaking-change semantics if half of v5 is brand-new.

### Option B — Extend existing `/api/v6` namespace

Add `dms.ts`, `inbox.ts`, `kbs.ts` to `packages/server/src/routes/v6/`. Register inside `registerV6Routes` alongside the existing v5-shim block.

- Pro: v6 already exists and is positioned as "the consolidated forward namespace." Adding new routes here matches its declared purpose.
- Pro: no client-pinning churn — clients that have already moved to v6 get the new features automatically.
- Pro: avoids a v7 bump only ~6 months after v6 launched.
- Con: v6 is currently *purely* a v5 superset; this is the first wave of net-new v6-only surface. We must be careful that new routes don't accidentally get a `Deprecation` header from the shim.

### Option C — Open `/api/v7`

Create a fresh namespace.

- Con: premature. v7 carries semantic weight in the product roadmap (project memory: `project_v7_vision.md` — OpenClaw runtime, Browser Use). Reserving v7 for that wave is more valuable than spending it here.

## Decision

**Option B.** New routes live under `/api/v6/dms/*`, `/api/v6/inbox/*`, `/api/v6/kbs/*`. The existing `registerV6Routes` (`packages/server/src/routes/v6/index.ts`) gains three new `await ...Routes(app)` calls.

## Consequences

- All routes in this spec use `/api/v6/...`. The new modules are net-new (not v5 shims) and must NOT receive the `addDeprecationHeaders()` treatment used for v5-equivalent paths.
- Dashboard `lib/api/` gets v6 client helpers for the three new namespaces. Existing v5/v6 helpers unchanged.
- The OpenAPI spec at `/api/v6/openapi.json` (`packages/server/src/routes/v6/openapi.ts`) needs to be regenerated/extended to cover the new endpoints.
- v7 namespace is preserved for the runtime/agent-platform wave (per `project_v7_vision.md`).

## Reference

- Existing v6 registration: `packages/server/src/routes/v6/index.ts:131`
- v5 sibling: `packages/server/src/routes/v5/index.ts:48`
- OpenAPI surface: `packages/server/src/routes/v6/openapi.ts`
