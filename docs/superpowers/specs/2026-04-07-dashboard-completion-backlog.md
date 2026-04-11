# Dashboard Completion Backlog (v6.7.4 → v6.8.0)

This is the planted backlog for the autonomous loop to drive dashboard completion. Each `TODO(autonomous):` line below is picked up by the proposal scanner and ranked into a sprint.

## Phase tab markdown rendering

TODO(autonomous): Render markdown content in cycle phases tab — use a markdown-to-HTML library so reviewer responses, gate rationales, and learn outputs display formatted text instead of raw JSON. Pick a small library like marked or markdown-it. Update packages/dashboard/src/routes/cycles/[id]/+page.svelte phases tab to render parsed JSON fields beautifully (cost, duration, agent runs, response markdown).

## Org graph + Organization agents

TODO(autonomous): Fix the /org dashboard route — verify the org graph endpoint returns real delegation data and the page renders nodes/edges correctly. Currently shows empty or broken state. Check packages/dashboard/src/routes/org/+page.svelte and the matching server route in packages/server/src/routes/v5/org-graph.ts.

TODO(autonomous): Fix the /agents dashboard route — verify the agent listing shows real agents from .agentforge/agents/*.yaml with name, model tier, description, and clickable detail pages. Currently broken. Check packages/dashboard/src/routes/agents/+page.svelte.

## Memory and Flywheel pages

TODO(autonomous): Wire up the /memory dashboard page to a real backend — currently shows static content. Read .agentforge/data/memories.json or similar and render real memory entries. Add a search box and filter by agent.

TODO(autonomous): Wire up the /flywheel dashboard page to real data — currently shows static gauges. Compute real metrics from cycles + sprints + sessions: meta-learning rate, autonomy score, capability inheritance, velocity. Update packages/dashboard/src/routes/flywheel/+page.svelte.

## Search

TODO(autonomous): Fix the /search dashboard route — currently returns no results regardless of query. Check what backend endpoint it hits and either implement the search backend or wire it to an existing one (sessions, cycles, agents, sprints, memories). Update packages/dashboard/src/routes/search/+page.svelte.

## Approvals

TODO(autonomous): Wire the /approvals dashboard page to the new server endpoints GET /api/v5/cycles/:id/approval and POST /api/v5/cycles/:id/approve. The endpoints already exist in packages/server/src/routes/v5/cycles.ts (v6.7.4). The dashboard needs to: (1) poll /api/v5/cycle-sessions for cycles with hasApprovalPending, (2) for each pending one fetch /api/v5/cycles/:id/approval and render the within-budget items as a checkbox list with cost totals, (3) POST to /api/v5/cycles/:id/approve with either {approveAll: true} or {approvedItemIds: [...], rejectedItemIds: [...]} when the user clicks Approve. Should also be triggered automatically as a global modal when an approval.pending event arrives via SSE. Update packages/dashboard/src/routes/approvals/+page.svelte and add a global ApprovalModal component to the layout.

## Branches

TODO(autonomous): Complete the /branches dashboard tab — show all autonomous/* branches with their cycle, age, status (open PR / merged / stale), and a button to delete stale branches. Update packages/dashboard/src/routes/branches/+page.svelte.

## Sprints

TODO(autonomous): Create a sprint JSON file for every existing version v4.3 through v6.7 in .agentforge/sprints/ that doesn't already have one. Use the existing v6.5.0.json shape as a template.

TODO(autonomous): Ensure /sprints/[version] detail page renders all fields beautifully: title, status, items kanban, success criteria, audit findings, completion percentage, dates. Already mostly built — verify and fill any gaps.

## Agent Runner + Activity Feed

TODO(autonomous): Complete the /runner dashboard route — fix the MODEL_TIERS undefined errors flagged by svelte-check, wire up the agent dispatch form to actually run agents, show output streaming back in real time. Check packages/dashboard/src/routes/runner/+page.svelte.

TODO(autonomous): Verify the /live activity feed renders cycle_event messages from the SSE stream — confirm the page subscribes correctly and renders events with proper colors, types, and timestamps.

## Playwright tests

TODO(autonomous): Add Playwright e2e tests under tests/e2e/ that exercise: dashboard home loads, cycles list loads, cycle detail page loads with real data, sprints list loads, sprints detail loads, settings save round-trips, /org graph renders, /agents list renders. Use the @playwright/test runner. Add a script `npm run test:e2e` to root package.json.
