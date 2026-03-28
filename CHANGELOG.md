# Changelog

All notable changes to AgentForge are documented in this file.

## [6.0.0] — 2026-03-27

### What's New

- **Execution API** — `POST /api/v5/run` triggers real AgentRuntime calls with live Anthropic API streaming. `GET /api/v5/run/:sessionId` for session retrieval. Agent YAML is resolved from `.agentforge/agents/` and model tier is mapped automatically.
- **AgentRuntime Streaming** — New `runStreaming()` method on `AgentRuntime` using the Anthropic SDK streaming API. Exposes `onChunk` and `onEvent` callbacks; output is published directly to the SSE message bus for real-time browser delivery.
- **Agent Runner Dashboard Page** — `/runner` route: enterprise UI to trigger live agent runs from the browser. Includes agent selector, task input, real-time SSE output panel, run history, and cost estimates.
- **Approvals Queue UI** — `/approvals` route: full human-in-the-loop approval workflow. Pending queue, approve/deny actions, auto-refresh, and queue stats.
- **Knowledge Graph UI** — `/knowledge` route: search, browse, and add knowledge store entries. Connects to the existing knowledge API.
- **Sprint API** — `GET /api/v5/sprints` and `GET /api/v5/sprints/:version` read `.agentforge/sprints/*.json` and normalize to a consistent schema.
- **Dashboard Navigation** — New sidebar entries: Agent Runner and Approvals under Operations; Knowledge under Intelligence.
- **Svelte 5 Migration** — Full migration from `$app/stores` to `$app/state`, reactive `$derived()` pattern, and fixed SSR hydration crashes.
- **CORS + Proxy Fix** — All API calls now use the Vite proxy (relative URLs). CORS configuration explicitly allows ports 4751 and 4752.
- **Server Route Deduplication** — Eliminated duplicate route registrations that caused "Method already declared" Fastify errors on startup.

### Breaking Changes

None.

### Migration Notes

- The dashboard requires the Svelte 5 runtime (`svelte ^5.55.0`). Ensure `packages/dashboard` dependencies are installed fresh if upgrading from v5.x.
- All dashboard API calls now use relative URLs via the Vite dev proxy (`/api/*` → `http://localhost:4750`). Any custom proxy configuration should be updated accordingly.
