# Dashboard Completion Backlog (v6.7.4 → v6.8.0)

This is the planted backlog for the autonomous loop to drive dashboard completion. Each `TODO(autonomous):` line below is picked up by the proposal scanner and ranked into a sprint.

## Phase tab markdown rendering

✅ DONE: Phases tab renders all structured data beautifully. `marked` v18 is installed as a production dependency. `MarkdownRenderer.svelte` parses full GFM markdown (headings, lists, code blocks, tables, blockquotes) with XSS-safe link/image handling. `phase-render.ts` exports: `markdownSections()` (extracts prose fields: findings, plan, review, rationale, retrospective, response, error, summary), `agentRunSections()` (extracts per-agent run responses with cost/duration metadata), `phaseMetaStats()` (formats status, cost, duration, run count, sprint version as stat chips), and `resolveAgentResponseContent()` (unwraps gate JSON verdicts into `**VERDICT**: prose` or fenced code blocks). The phases tab in `+page.svelte` uses all these: stat chips for structured fields, collapsible raw JSON for remaining metadata, MarkdownRenderer for all prose sections and agent run responses. 35 unit tests covering all utility functions pass alongside 237 total dashboard tests.

## Org graph + Organization agents

TODO(autonomous): Fix the /org dashboard route — verify the org graph endpoint returns real delegation data and the page renders nodes/edges correctly. Currently shows empty or broken state. Check packages/dashboard/src/routes/org/+page.svelte and the matching server route in packages/server/src/routes/v5/org-graph.ts.

✅ DONE: /agents dashboard route lists real agents from .agentforge/agents/*.yaml — renders name, model tier (badge), team, effort, description columns in a sortable table with clickable detail pages (/agents/[id]). Server-side load via +page.server.ts reads YAML directly (no backend dependency); client-side refresh via GET /api/v5/agents updates on mount. Team filter chips, search, and __unassigned__ filter all working. 25 unit tests + 6 API route tests passing, 0 svelte-check errors.

## Memory and Flywheel pages

✅ DONE: /memory dashboard page wired to real backend. +page.server.ts reads .agentforge/memory/*.jsonl (primary) and .agentforge/data/memories.json (curated fallback), merges and deduplicates by id, sorts newest-first, and returns up to 200 entries with `agents` and `types` arrays for the filter dropdowns. +page.svelte initialises from SSR data (no loading skeleton on first paint), adds a debounced search box (/ shortcut to focus), an agent-filter select, and type-filter chips — all forwarding to the server for datasets larger than 200. SSE live-updates via /api/v1/stream trigger batch refreshes on cycle.complete and memory_written events. 40 unit tests in packages/dashboard/src/__tests__/memory-page-server.test.ts covering empty states, field mapping, JSONL reading, curated merge, deduplication, search/agent/type filters, filter-before-cap correctness, and a real-project smoke test.

TODO(autonomous): Wire up the /flywheel dashboard page to real data — currently shows static gauges. Compute real metrics from cycles + sprints + sessions: meta-learning rate, autonomy score, capability inheritance, velocity. Update packages/dashboard/src/routes/flywheel/+page.svelte.

## Search

✅ DONE: /search dashboard route is fully implemented. POST /api/v5/search endpoint in packages/server/src/routes/v5/search.ts searches across sessions (via adapter), agents (.agentforge/agents/*.yaml), sprints (.agentforge/sprints/*.json), cycles (.agentforge/cycles/ and cycles-archived/), and memory (.agentforge/memory/*.json|.md|.jsonl). Frontend at packages/dashboard/src/routes/search/+page.svelte calls the endpoint with type-filter chips and renders results with score bars, clickable type badges, and deep-link navigation (agent→/agents/[id], cycle→/cycles/[id], sprint→/sprints/[version]). 18 unit tests passing.

## Approvals

TODO(autonomous): Wire the /approvals dashboard page to the new server endpoints GET /api/v5/cycles/:id/approval and POST /api/v5/cycles/:id/approve. The endpoints already exist in packages/server/src/routes/v5/cycles.ts (v6.7.4). The dashboard needs to: (1) poll /api/v5/cycle-sessions for cycles with hasApprovalPending, (2) for each pending one fetch /api/v5/cycles/:id/approval and render the within-budget items as a checkbox list with cost totals, (3) POST to /api/v5/cycles/:id/approve with either {approveAll: true} or {approvedItemIds: [...], rejectedItemIds: [...]} when the user clicks Approve. Should also be triggered automatically as a global modal when an approval.pending event arrives via SSE. Update packages/dashboard/src/routes/approvals/+page.svelte and add a global ApprovalModal component to the layout.

## Branches

TODO(autonomous): Complete the /branches dashboard tab — show all autonomous/* branches with their cycle, age, status (open PR / merged / stale), and a button to delete stale branches. Update packages/dashboard/src/routes/branches/+page.svelte.

## Sprints

✅ DONE: All sprint JSON files v4.3 through v6.7 exist and conform to the v6.5.0.json template structure (10 files converted from legacy format to proper "sprints" wrapper, 22 already correct).

TODO(autonomous): Ensure /sprints/[version] detail page renders all fields beautifully: title, status, items kanban, success criteria, audit findings, completion percentage, dates. Already mostly built — verify and fill any gaps.

## Agent Runner + Activity Feed

TODO(autonomous): Complete the /runner dashboard route — fix the MODEL_TIERS undefined errors flagged by svelte-check, wire up the agent dispatch form to actually run agents, show output streaming back in real time. Check packages/dashboard/src/routes/runner/+page.svelte.

TODO(autonomous): Verify the /live activity feed renders cycle_event messages from the SSE stream — confirm the page subscribes correctly and renders events with proper colors, types, and timestamps.

## Playwright tests

TODO(autonomous): Add Playwright e2e tests under tests/e2e/ that exercise: dashboard home loads, cycles list loads, cycle detail page loads with real data, sprints list loads, sprints detail loads, settings save round-trips, /org graph renders, /agents list renders. Use the @playwright/test runner. Add a script `npm run test:e2e` to root package.json.
