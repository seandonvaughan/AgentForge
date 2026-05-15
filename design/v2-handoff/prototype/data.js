// V2 full prototype — mock data with rich time series for charts/sparklines.
(function () {
  const now = Date.now();
  function ts(min) { return new Date(now - min * 60000).toISOString(); }
  function spark(n, base, vol) {
    return Array.from({ length: n }, (_, i) => Math.max(0, base + Math.sin(i/2)*vol + (Math.random()-0.5)*vol));
  }

  // Generate a smoother trending series for KPI charts
  function trend(n, start, end, vol = 1) {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const v = start + (end - start) * t + (Math.random()-0.5)*vol;
      arr.push(Math.max(0, v));
    }
    return arr;
  }

  window.AF2 = {

    workspace: { id: 'mnamto1u-hfrn3l', name: 'default', path: '~/Projects/AgentForge' },
    version: '10.5.1',

    // ── active cycle (hero) ───────────────────────────────────────────────
    cycle: {
      id: 'b555cca4-5697-46ae-9b4d-49b97e871124', short: 'b555cca4',
      sprintVersion: '14.1.0',
      stage: 'execute',
      stageIdx: 2,
      stages: ['done','done','active','pending','pending','pending'],
      elapsedSec: 5719, elapsedDisplay: '01:35:19',
      costUsd: 5.89, budgetUsd: 200,
      itemsTotal: 5, itemsDone: 3, itemsActive: 1, itemsFailed: 0,
      testsPassed: 4832, testsTotal: 4837,
      activeAgent: 'coder', activeModel: 'sonnet', activePhase: 'execute',
      branch: 'autonomous/v14.1.0',
      commitSha: null, prUrl: null,
      approvalPending: false,
      phases: [
        { name:'PLAN',    status:'done',    durMs:240000,  costUsd:0.412, agent:'researcher',   model:'haiku',  detail:'Audited 5 candidate items · approved 5' },
        { name:'STAGE',   status:'done',    durMs:120000,  costUsd:0.106, agent:'cto',          model:'opus',   detail:'Assigned 5 items across 4 agents' },
        { name:'RUN',     status:'active',  durMs:5350000, costUsd:4.890, agent:'coder',        model:'sonnet', detail:'3/5 items complete · 1 in flight (item-4)' },
        { name:'VERIFY',  status:'pending', durMs:null,    costUsd:null,  agent:null,           model:null,     detail:'Awaiting completion of RUN phase' },
        { name:'COMMIT',  status:'pending', durMs:null,    costUsd:null,  agent:null,           model:null,     detail:'—' },
        { name:'REVIEW',  status:'pending', durMs:null,    costUsd:null,  agent:null,           model:null,     detail:'—' },
      ],
    },

    // ── recent cycles (list view) ─────────────────────────────────────────
    cycles: [
      { id:'b555cca4', v:'14.1.0', stage:'active',    elapsed:'1h 35m',  cost:5.89,  budget:200, tests:'4832/4837', stages:['done','done','active','pending','pending','pending'], at: ts(95) },
      { id:'21e08f56', v:'14.0.0', stage:'completed', elapsed:'24m 32s', cost:2.61,  budget:250, tests:'4791/4800', stages:['done','done','done','done','done','done'],            at: ts(240),     pr:'#47' },
      { id:'4424e214', v:'10.6.0', stage:'completed', elapsed:'32m 13s', cost:17.13, budget:200, tests:'4750/4791', stages:['done','done','done','done','done','done'],            at: ts(28*1440), pr:'#46' },
      { id:'dd3f7c94', v:'10.5.0', stage:'completed', elapsed:'32m 25s', cost:21.21, budget:200, tests:'4780/4800', stages:['done','done','done','done','done','done'],            at: ts(45*1440), pr:'#45' },
      { id:'fb07d93a', v:'10.3.0', stage:'completed', elapsed:'31m 54s', cost:15.79, budget:200, tests:'4720/4760', stages:['done','done','done','done','done','done'],            at: ts(45*1440), pr:'#44' },
      { id:'378652a2', v:'12.0.0', stage:'failed',    elapsed:'48m 10s', cost:31.61, budget:500, tests:'4700/4791', stages:['done','done','failed','pending','pending','pending'], at: ts(28*1440) },
      { id:'eled9c0e', v:'13.0.0', stage:'failed',    elapsed:'49m 20s', cost:25.02, budget:500, tests:'4700/4837', stages:['done','done','done','failed','pending','pending'],   at: ts(27*1440) },
      { id:'fbab0e1a', v:'11.0.0', stage:'failed',    elapsed:'52m 43s', cost:27.71, budget:500, tests:'4670/4791', stages:['done','done','done','failed','pending','pending'],   at: ts(28*1440) },
      { id:'9a567161', v:'10.2.1', stage:'completed', elapsed:'42m 41s', cost:0.11,  budget:200, tests:'4650/4700', stages:['done','done','done','done','done','done'],            at: ts(46*1440), pr:'#43' },
      { id:'leb9d9fd', v:null,    stage:'failed',    elapsed:'12s',     cost:14.36, budget:200, tests:null,         stages:['failed','pending','pending','pending','pending','pending'], at: ts(27*1440) },
    ],

    // ── KPIs with rich sparklines ──────────────────────────────────────────
    kpis: {
      passRate:    { value: 99.8,  delta: '+0.4',  unit:'%',   spark: trend(20, 96, 99.8, 1.5) },
      costPerCycle:{ value: 12.40, delta: '-18%', unit:'$',   spark: trend(20, 18, 12.4, 2.5) },
      cycleTime:   { value: 47,    delta: '-6m',  unit:'min', spark: trend(20, 58, 47, 4) },
      autonomy:    { value: 69,    delta: '+5',   unit:'%',   spark: trend(20, 60, 69, 3) },
      throughput:  { value: 8,     delta: '+2',   unit:'/d',  spark: trend(20, 5, 8, 1) },
      mttr:        { value: 24,    delta: '-12m', unit:'min', spark: trend(20, 38, 24, 5) },
    },

    // ── live agent activity ────────────────────────────────────────────────
    agentsLive: [
      { id:'coder',         model:'sonnet', phase:'execute', cost: 4.233, dur:'38m 15s', state:'running', spark: spark(20, 0.5, 0.4),
        output: `## Current task: item-4 — live cost tracking on agents tab

Working on the \`<AgentCostSparkline>\` component.

### Progress

- Wired up the time-series accumulator
- Sparkline renders with smooth update on every poll tick
- Tooltip on hover working

### Files modified

\`\`\`
src/lib/components/AgentCostSparkline.svelte   (new, +127 lines)
src/lib/stores/cost-stream.ts                  (new, +89 lines)
src/routes/cycles/[id]/+page.svelte            (+42 −15)
src/lib/util/phase-render.ts                   (+89 −4)
\`\`\`

### What's left

- Edge case: cap running cost when agent fails partway through
- Add tests for the accumulator

### Decisions

Used \`requestAnimationFrame\` for the sparkline update instead of a setInterval — much smoother during heavy reflow.

> Pattern note: extracted the time-series buffer into a Svelte store so we can reuse it elsewhere later.

I'll commit when the failure-cap edge case is handled.` },
      { id:'researcher',    model:'haiku',  phase:'audit',   cost: 0.412, dur:'3m 17s',  state:'done',    spark: spark(20, 0.1, 0.1),
        output: `## Audit complete: 5 candidate items reviewed

All 5 items met the **acceptance criteria** and are approved for execution.

### Items audited

1. **#1** — Render markdown content — *clear scope, acceptance criteria explicit*
2. **#2** — Improve phase metadata — *good, but consider how chips behave on narrow viewports*
3. **#3** — Fix SSE reconnection loop — *high impact, low scope, ship it*
4. **#4** — Live cost tracking — *moderate complexity, watch for cost-attribution bugs*
5. **#5** — Approval modal UX — *acceptance criteria need keyboard-shortcut spec*

### Recommendations

- Item #5 should specify which keys map to approve/deny before execute starts. \`Y/N\` or \`Enter/Esc\`?
- Item #4 has implicit dependency on item #2 (sparklines need the chip layout)

### Risk assessment

\`Low\` — no items touch payment flows, auth, or data migrations.` },
      { id:'cto',           model:'opus',   phase:'plan',    cost: 0.106, dur:'59s',     state:'done',    spark: spark(20, 0.2, 0.15),
        output: `## Sprint plan: v14.1.0

Promoted from \`14.0.0 → 14.1.0\` based on the **minor-bump** feature/capability tags found during audit.

### Scope

5 items, all targeted at dashboard ergonomics:

- Markdown rendering for phase content (#1)
- Structured chips for phase metadata (#2)
- SSE reconnection backoff (#3)
- Live cost tracking on agents tab (#4)
- Approval modal UX (#5)

### Assignments

| Item | Owner | Model |
|---|---|---|
| #1 | coder | sonnet |
| #2 | coder | sonnet |
| #3 | coder | sonnet |
| #4 | coder | sonnet |
| #5 | coder | sonnet |

### Budget allocation

\`$200\` total → estimated \`$6.10\` based on prior similar cycles. Headroom: \`$193.90\`.

### Risks

- Item #4 has highest variance — sparkline performance edge cases could blow the estimate.
- Item #5 depends on item #1 being merged first.` },
      { id:'backend-qa',    model:'haiku',  phase:'test',    cost: 0.551, dur:'queued',  state:'queued',  spark: spark(20, 0.05, 0.05), output: null },
      { id:'code-reviewer', model:'sonnet', phase:'review',  cost: 0.379, dur:'queued',  state:'queued',  spark: spark(20, 0.05, 0.05), output: null },
      { id:'ceo',           model:'opus',   phase:'gate',    cost: 0.095, dur:'queued',  state:'queued',  spark: spark(20, 0.02, 0.02), output: null },
    ],

    // ── event stream (live) ────────────────────────────────────────────────
    events: [
      { t: ts(0.2), type:'agent.heartbeat',  agent:'coder',     msg:'execute · processing item 4/5 · 73%' },
      { t: ts(0.5), type:'tests.partial',    agent:'backend-qa',msg:'4801/4837 passed (36 in queue)' },
      { t: ts(1.2), type:'item.completed',   agent:'coder',     msg:'item 3 merged · v14.1.0/item-render-markdown' },
      { t: ts(2.5), type:'file.changed',     agent:'coder',     msg:'src/lib/components/MarkdownRenderer.svelte +127 -8' },
      { t: ts(4),   type:'agent.start',      agent:'coder',     msg:'starting item 4: live-cost-tracking' },
      { t: ts(7),   type:'item.completed',   agent:'coder',     msg:'item 2 done · 12 files changed · 4.2s' },
      { t: ts(12),  type:'phase.transition', agent:null,        msg:'STAGE → RUN' },
      { t: ts(13),  type:'agent.completed',  agent:'cto',       msg:'plan phase done · $0.106 · 59s' },
      { t: ts(15),  type:'phase.transition', agent:null,        msg:'PLAN → STAGE' },
      { t: ts(18),  type:'agent.start',      agent:'cto',       msg:'planning sprint · v14.1.0' },
      { t: ts(20),  type:'agent.completed',  agent:'researcher',msg:'audit phase done · $0.412 · 3m 17s' },
      { t: ts(25),  type:'agent.start',      agent:'researcher',msg:'auditing 5 candidate items' },
      { t: ts(35),  type:'cycle.start',      agent:null,        msg:'cycle b555cca4 launched · budget $200 · maxItems 8' },
      { t: ts(40),  type:'sprint.loaded',    agent:null,        msg:'sprint v14.1.0 · 5 items' },
    ],

    // ── counters (status line) ─────────────────────────────────────────────
    counters: {
      agents: 139, agentsActive: 1, agentsQueued: 4,
      openBranches: 1, pendingMerges: 0, pendingApprovals: 0,
      totalSpend: 2.4421, todaySpend: 5.89,
      cyclesDay: 8, cyclesWeek: 38, cyclesMonth: 142,
      sprintItems: { done: 676, total: 848 },
      load: [0.42, 0.38, 0.31],
    },

    // ── sprint items for cycle detail ──────────────────────────────────────
    items: [
      { id:'1', title:'Render markdown content in cycle phases tab — use marked or markdown-it to parse phase JSON responses', status:'completed', assignee:'coder',  model:'sonnet', dur:'18m 22s', cost:1.420, files:3,
        output: `## Summary

Implemented markdown rendering for the **phases tab** of the cycle detail page. The previous implementation rendered phase JSON responses as raw text inside a \`<pre>\` block, which was unreadable for anything longer than a few lines.

## Approach

After evaluating \`marked\`, \`markdown-it\`, and \`micromark\`, I went with **\`marked\`** for these reasons:

1. Smallest bundle: 12KB minified, vs. 47KB for markdown-it.
2. GFM support out of the box (tables, task lists, autolinks).
3. Sync API — no async loading dance in the Svelte component lifecycle.
4. Already a transitive dep elsewhere in the tree.

### Implementation

- Added \`src/lib/util/markdown.ts\` with a configured \`marked\` instance (GFM on, breaks on, sanitizer via DOMPurify).
- Created \`<MarkdownRenderer>\` Svelte component that takes a \`content\` prop and emits sanitized HTML.
- Wired into the phases tab — both phase response and reviewer rationale now render as proper markdown.

### Code changes

- \`src/lib/util/markdown.ts\` *(new)*
- \`src/lib/components/MarkdownRenderer.svelte\` *(new)*
- \`src/routes/cycles/[id]/+page.svelte\` *(updated)*

## Tests

Added unit tests for the markdown utility covering edge cases:

- Empty input → empty output
- Malicious script tags → stripped by DOMPurify
- Nested lists, fenced code blocks, tables

All passing. \`5 new tests, 0 regressions.\`

## Notes for reviewer

The \`<MarkdownRenderer>\` uses \`{@html}\` — I considered this carefully and confirmed with the security audit that DOMPurify covers our threat model here (input is from our own agents, not user-submitted).

> Next sprint: consider extracting MarkdownRenderer as a reusable primitive for the events tab and approvals modal too.` },
      { id:'2', title:'Improve phase metadata rendering with structured chips for cost/duration/runs', status:'completed', assignee:'coder', model:'sonnet', dur:'9m 41s',  cost:0.892, files:2,
        output: `## Summary

Replaced the raw JSON dump above markdown phase content with **structured stat chips** showing status, cost, duration, and agent runs at-a-glance.

## What changed

Before this change, the phases tab rendered phase metadata as a raw JSON blob — operators had to mentally parse \`{"status":"completed","cost":{"totalUsd":0.412},...}\` to find the numbers that matter.

Now we extract the canonical stats and render them as **inline chips** above the prose:

- \`status\` chip — color-coded (green/red/yellow)
- \`cost\` chip — formatted as \`$0.412\`
- \`duration\` chip — formatted as \`3m 17s\`
- \`agent runs\` chip — count of runs in the phase

The raw JSON is still available behind a \`<details>\` "Raw metadata" toggle for debugging.

## Reused existing components

This used the existing \`<Badge>\` and \`<StatChip>\` primitives — no new components introduced. Saved ~30% time vs. building from scratch.

## Files touched

\`\`\`
src/lib/util/phase-render.ts
src/routes/cycles/[id]/+page.svelte
\`\`\`

Tests: 4 new, all passing.` },
      { id:'3', title:'Fix SSE reconnection loop with exponential backoff to avoid hammering the server', status:'completed', assignee:'coder', model:'sonnet', dur:'5m 03s',  cost:0.461, files:1,
        output: `## Summary

The SSE connection in \`/api/v5/stream\` had a tight reconnection loop that hammered the server when the connection dropped — operators reported seeing dozens of reconnect attempts per second after a network blip.

## Root cause

The \`onerror\` handler was calling \`reconnect()\` synchronously with no backoff. When the server was actually down, this created a CPU-pegging loop.

## Fix

Implemented **exponential backoff with jitter**, capped at 30s:

\`\`\`ts
const baseMs = 1000;
const maxMs  = 30_000;
const attempt = state.reconnectAttempts;
const delay = Math.min(maxMs, baseMs * 2 ** attempt) + Math.random() * 500;
setTimeout(reconnect, delay);
\`\`\`

Also added a \`reconnectAttempts\` reset when a successful message arrives — so a transient blip doesn't permanently slow reconnection.

## Verification

Manual test: stopped the API server, watched browser network tab. Reconnection attempts:
\`1.2s → 2.4s → 4.1s → 8.7s → 16.2s → 30.4s → 30.1s → …\`

Production-grade.` },
      { id:'4', title:'Add live cost tracking to cycles detail agents tab with sparklines per agent over phase timeline', status:'in_progress', assignee:'coder', model:'sonnet', dur:'12m 18s', cost:1.460, files:6,
        output: `## In progress (73% complete)

Implementing live cost tracking on the **Agents tab** of cycle detail. The tab currently shows aggregate per-agent stats; this change adds:

1. A **running cost sparkline** per agent, updating every 3s via the existing poll
2. A **phase timeline** beneath each sparkline showing which phases the agent ran in
3. **Cost attribution** for items in flight (the active agent's running burn rate)

## Done so far

- ✅ Added \`cost.tsx\` time-series accumulator
- ✅ Wired \`<AgentCostSparkline>\` into the agent cards
- ✅ Phase timeline visualization (small horizontal segments)
- ✅ Total cost banner with animated count-up

## Remaining

- ⏳ Cost-attribution edge case: when an agent fails partway through an item, the running cost should be capped at the failure point, not extrapolated
- ⏳ Tooltip on hover showing per-phase breakdown
- ⏳ Tests for the sparkline data accumulator

## Blockers

None — should land within the next 4 minutes.` },
      { id:'5', title:'Update approval modal with improved UX — keyboard shortcuts, better loading states, auto-dismiss', status:'planned', assignee:null, model:null, dur:null, cost:null, files:0, output: null },
    ],

    // ── agents directory ───────────────────────────────────────────────────
    agents: [
      { name:'Agent API Developer',       id:'agent-api-dev',             model:'haiku',  team:'Runtime',         effort:'LOW',  desc:'Implements agent-runner, client, API endpoints', spend: 0.42 },
      { name:'Agent Intelligence Lead',   id:'agent-intelligence-lead',   model:'sonnet', team:'R&D Intelligence',effort:'HIGH', desc:'Leads R&D for agent intelligence systems',        spend: 0.85 },
      { name:'Agent Protocol Researcher', id:'agent-protocol-researcher', model:'haiku',  team:'R&D Integration', effort:'LOW',  desc:'Researches agent-to-agent communication',         spend: 0.18 },
      { name:'Agent Template Author',     id:'agent-template-author',     model:'haiku',  team:'Core Platform',   effort:'LOW',  desc:'Writes agent YAML templates and skill defs',       spend: 0.22 },
      { name:'API Gateway Engineer',      id:'api-gateway-engineer',      model:'sonnet', team:null,              effort:null,   desc:'Owns Fastify route definitions and middleware',     spend: 0.61 },
      { name:'Architect',                 id:'architect',                 model:'opus',   team:'Strategic',       effort:'HIGH', desc:'High-level system design decisions',                spend: 1.84 },
      { name:'Backend QA',                id:'backend-qa',                model:'haiku',  team:'Quality',         effort:'LOW',  desc:'API test automation, load testing',                 spend: 0.31 },
      { name:'Backlog Scorer',            id:'backlog-scorer',            model:'sonnet', team:'Strategic',       effort:'MEDIUM',desc:'Ranks candidate sprint items by value',             spend: 0.74 },
      { name:'Benchmark Lead',            id:'benchmark-lead',            model:'sonnet', team:'Runtime',         effort:'HIGH', desc:'Owns launch gate benchmarks and regression suite',   spend: 1.12 },
      { name:'Budget Strategy Researcher',id:'budget-strategy-researcher',model:'haiku',  team:'R&D Cost',        effort:'LOW',  desc:'Researches budget management strategies',           spend: 0.12 },
      { name:'CEO',                       id:'ceo',                       model:'opus',   team:'Strategic',       effort:'MAX',  desc:'Strategic decision making, org leadership',         spend: 2.34 },
      { name:'CFO',                       id:'cfo',                       model:'opus',   team:'Strategic',       effort:'HIGH', desc:'Financial strategy, budget oversight',              spend: 1.45 },
      { name:'coder',                     id:'coder',                     model:'sonnet', team:'Core Platform',   effort:'HIGH', desc:'Implements code changes following technical specs', spend: 4.233 },
      { name:'code-reviewer',             id:'code-reviewer',             model:'sonnet', team:'Quality',         effort:'MEDIUM',desc:'Reviews code changes for quality and correctness',  spend: 0.379 },
      { name:'CTO',                       id:'cto',                       model:'opus',   team:'Strategic',       effort:'HIGH', desc:'Technical leadership, architecture decisions',      spend: 1.84 },
      { name:'data-analyst',              id:'data-analyst',              model:'haiku',  team:'Quality',         effort:'LOW',  desc:'Data analysis, metrics, cycle reporting',           spend: 0.114 },
      { name:'docs-writer',               id:'docs-writer',               model:'haiku',  team:'Core Platform',   effort:'LOW',  desc:'Documentation writer for public API',               spend: 0.08 },
      { name:'embed-specialist',          id:'embed-specialist',          model:'sonnet', team:'R&D Intelligence',effort:'MEDIUM',desc:'Embedding models and semantic search',              spend: 0.51 },
      { name:'frontend-engineer',         id:'frontend-engineer',         model:'sonnet', team:'Core Platform',   effort:'MEDIUM',desc:'Frontend implementation: SvelteKit, React',         spend: 0.92 },
      { name:'infra-engineer',            id:'infra-engineer',            model:'haiku',  team:'Runtime',         effort:'LOW',  desc:'Infrastructure, deployment pipelines',              spend: 0.21 },
      { name:'memory-architect',          id:'memory-architect',          model:'opus',   team:'R&D Intelligence',effort:'HIGH', desc:'Designs agent memory and knowledge inheritance',    spend: 1.21 },
      { name:'researcher',                id:'researcher',                model:'haiku',  team:null,              effort:null,   desc:'General research, audit phase, info gathering',     spend: 0.412 },
      { name:'security-auditor',          id:'security-auditor',          model:'sonnet', team:'Quality',         effort:'MEDIUM',desc:'Security audit, vulnerability scanning',            spend: 0.34 },
    ],

    // ── org tree (flat with parent refs for graph) ────────────────────────
    org: [
      { id:'ceo',           name:'CEO',                       model:'opus',   parent:null,  cost: 2.34, dir: 5 },
      { id:'cto',           name:'CTO',                       model:'opus',   parent:'ceo', cost: 1.84, dir: 4 },
      { id:'cfo',           name:'CFO',                       model:'opus',   parent:'ceo', cost: 1.45, dir: 1 },
      { id:'architect',     name:'Architect',                 model:'opus',   parent:'cto', cost: 1.84, dir: 0 },
      { id:'lead-arch',     name:'Lead Architect',            model:'opus',   parent:'cto', cost: 0.42, dir: 8 },
      { id:'rd-lead',       name:'R&D Lead',                  model:'opus',   parent:'cto', cost: 0.18, dir: 5 },
      { id:'vpe',           name:'VP Engineering',            model:'opus',   parent:'cto', cost: 0.78, dir: 5 },
      { id:'core-plat',     name:'Core Platform Lead',        model:'sonnet', parent:'lead-arch', cost:0.61, dir:11 },
      { id:'cost-engine',   name:'Cost Engine Designer',      model:'sonnet', parent:'lead-arch', cost:0.18, dir:0 },
      { id:'exp-design',    name:'Experience Design Lead',    model:'sonnet', parent:'lead-arch', cost:0.31, dir:6 },
      { id:'runtime-plat',  name:'Runtime Platform Lead',     model:'sonnet', parent:'lead-arch', cost:0.74, dir:13 },
      { id:'agent-int',     name:'Agent Intelligence Lead',   model:'sonnet', parent:'vpe', cost:0.85, dir:3 },
      { id:'embed',         name:'Embedding Specialist',      model:'sonnet', parent:'rd-lead', cost:0.51, dir:0 },
      { id:'researcher',    name:'researcher',                model:'haiku',  parent:'rd-lead', cost:0.412, dir:0 },
      { id:'coder',         name:'coder',                     model:'sonnet', parent:'core-plat', cost:4.233, dir:0 },
      { id:'frontend',      name:'frontend-engineer',         model:'sonnet', parent:'core-plat', cost:0.92, dir:0 },
      { id:'code-reviewer', name:'code-reviewer',             model:'sonnet', parent:'core-plat', cost:0.379, dir:0 },
      { id:'backend-qa',    name:'backend-qa',                model:'haiku',  parent:'runtime-plat', cost:0.551, dir:0 },
      { id:'data-analyst',  name:'data-analyst',              model:'haiku',  parent:'runtime-plat', cost:0.114, dir:0 },
      { id:'infra',         name:'infra-engineer',            model:'haiku',  parent:'runtime-plat', cost:0.21, dir:0 },
    ],

    // ── model distribution ─────────────────────────────────────────────────
    modelMix: { opus: 11, sonnet: 62, haiku: 66 },

    // ── 24-hour activity heatmap (cycles per hour) ─────────────────────────
    heatmap: trend(24, 4, 8, 3),

    // ── sessions ───────────────────────────────────────────────────────────
    sessions: [
      { agent:'coder',              task:'do something',                                      model:'claude-sonnet-4-6', status:'running',   dur:null,    cost:0.0000, at: ts(0.2) },
      { agent:'cto',                task:'v5.3 is a go. CEO directive: spend 10x more.',       model:'claude-opus-4-6',   status:'completed', dur:'1m 23s', cost:0.1500, at: ts(20) },
      { agent:'build-release-lead', task:'v4.8 release: version bump, sprint finalization',   model:'claude-sonnet-4-6', status:'completed', dur:'4m 18s', cost:0.1500, at: ts(45) },
      { agent:'cto',                task:'CEO v4.8 directive: data-driven dashboard',          model:'claude-opus-4-6',   status:'completed', dur:'2m 04s', cost:0.1500, at: ts(120) },
      { agent:'ceo',                task:'FOUNDER DIRECTIVE — v5.5 through v7 Strategy',       model:'claude-opus-4-6',   status:'completed', dur:'0m 41s', cost:0.0151, at: ts(180) },
      { agent:'build-release-lead', task:'v4.8 release: version bump 0.4.7 → 0.4.8',           model:'claude-sonnet-4-6', status:'completed', dur:'8m 12s', cost:1.3500, at: ts(300) },
      { agent:'ceo',                task:'v5.4 directive: 100x spend, solid system',           model:'claude-opus-4-6',   status:'completed', dur:'1m 18s', cost:0.0581, at: ts(600) },
      { agent:'cto',                task:'CEO authorized v4.8. $1,200 budget, 16 new hires',   model:'claude-opus-4-6',   status:'completed', dur:'0m 52s', cost:0.0100, at: ts(700) },
      { agent:'researcher',         task:'Audit 5 candidate items for v14.1.0',                model:'claude-haiku-4-6',  status:'completed', dur:'3m 17s', cost:0.4120, at: ts(115) },
      { agent:'backend-qa',         task:'Run integration test suite against v14.1.0 branch',  model:'claude-haiku-4-6',  status:'running',   dur:null,    cost:0.2310, at: ts(2) },
    ],

    // ── scoring (per-cycle quality assessment) ────────────────────────────
    scoring: {
      cycleId: 'b555cca4',
      overall: 78,
      delta: '+4',
      summary: 'Cycle delivered 3/5 items within budget. Test suite at 99.9% pass rate. Item #5 (approval modal) failed integration tests at the review gate.',
      warnings: ['Item #5 failed 5 integration tests', 'Cost ran 3% over estimated baseline'],
      dimensions: [
        { key:'velocity', label:'Velocity', score:85, max:100, detail:'3 of 5 items shipped · pace +12% vs trailing avg', color:'#a78bfa' },
        { key:'quality',  label:'Quality',  score:92, max:100, detail:'99.9% pass rate · 5 failures in 1 file',          color:'#5bd394' },
        { key:'cost',     label:'Cost',     score:88, max:100, detail:'$5.89 of $200 budget (3%)',                       color:'#7aa0f7' },
        { key:'autonomy', label:'Autonomy', score:65, max:100, detail:'1 manual intervention required (item-5 retry)',   color:'#f5a623' },
        { key:'safety',   label:'Safety',   score:95, max:100, detail:'No prod incidents · all gates respected',          color:'#5bd394' },
        { key:'learning', label:'Learning', score:72, max:100, detail:'8 new memory entries · 2 patterns recognized',     color:'#a78bfa' },
      ],
      items: [
        { id:'1', title:'Render markdown content in cycle phases tab', score:88, confidence:'high',   cost:1.420, withinBudget:true,  rationale:'Clean implementation with marked library; tests passing; scope contained.' },
        { id:'2', title:'Improve phase metadata rendering',           score:92, confidence:'high',   cost:0.892, withinBudget:true,  rationale:'Good visual polish; reused existing chip component; saved 30% time.' },
        { id:'3', title:'Fix SSE reconnection loop',                   score:95, confidence:'high',   cost:0.461, withinBudget:true,  rationale:'Exponential backoff with capped retry — production-grade implementation.' },
        { id:'4', title:'Add live cost tracking to agents tab',        score:70, confidence:'medium', cost:1.460, withinBudget:true,  rationale:'In progress; sparkline + live polling working; cost-attribution edge cases remain.' },
        { id:'5', title:'Update approval modal UX',                    score:35, confidence:'low',    cost:0.150, withinBudget:true,  rationale:'Failed: integration tests broke for keyboard shortcut handling at the review gate.' },
      ],
    },

    // ── flywheel ───────────────────────────────────────────────────────────
    flywheel: {
      overall: 87,
      metrics: [
        { key:'meta',   label:'META-LEARNING', score:94, color:'#a78bfa', detail:'60 sprint iterations; pass-rate stable across 18 cycles' },
        { key:'auto',   label:'AUTONOMY',      score:69, color:'#7aa0f7', detail:'9/18 cycles · 8/9 sessions satisfied' },
        { key:'inh',    label:'INHERITANCE',   score:94, color:'#5bd394', detail:'139 agents · 18 cycles with file evidence' },
        { key:'vel',    label:'VELOCITY',      score:90, color:'#f5a623', detail:'676/848 sprint items · 8 sessions completed' },
      ],
      loop: { cyclesRun:38, completed:9, meaningful:18, sprintIter:60, agents:139, itemsDone:676, itemsTotal:848 },
      memory: { active:true, entries:76, hitRate:78, learningCycles:7, totalCycles:9 },
    },

    // ── services ───────────────────────────────────────────────────────────
    services: [
      { service:'anthropic',  successRate:1.0, totalCalls:847, failureCount:0, p99:412, spark: trend(20, 99, 100, 0.3) },
      { service:'database',   successRate:1.0, totalCalls:12380, failureCount:0, p99: 18, spark: trend(20, 99, 100, 0.2) },
      { service:'embeddings', successRate:0.998, totalCalls:421, failureCount:1, p99: 240, spark: trend(20, 99, 99.9, 0.4) },
      { service:'git',        successRate:1.0, totalCalls:142, failureCount:0, p99:88, spark: trend(20, 100, 100, 0.1) },
      { service:'federation', successRate:1.0, totalCalls:34, failureCount:0, p99:32, spark: trend(20, 100, 100, 0.1) },
    ],

    // ── branches ───────────────────────────────────────────────────────────
    branches: [
      { name:'autonomous/v14.1.0', cycle:'b555cca4', state:'building', age:'1h 35m', pr:null, author:'coder',         model:'sonnet', ahead:8,  behind:0, conflicts:0 },
      { name:'autonomous/v14.0.0', cycle:'21e08f56', state:'merged',   age:'4h',     pr:'#47', author:'coder',         model:'sonnet', ahead:0,  behind:0, conflicts:0 },
      { name:'autonomous/v10.6.0', cycle:'4424e214', state:'merged',   age:'28d',    pr:'#46', author:'coder',         model:'sonnet', ahead:0,  behind:0, conflicts:0 },
      { name:'autonomous/v13.0.0', cycle:'eled9c0e', state:'stale',    age:'27d',    pr:null, author:'coder',         model:'sonnet', ahead:12, behind:24,conflicts:2 },
      { name:'autonomous/v12.0.0', cycle:'378652a2', state:'stale',    age:'28d',    pr:null, author:'coder',         model:'sonnet', ahead:6,  behind:24,conflicts:0 },
    ],

    // ── approvals queue ───────────────────────────────────────────────────
    approvals: [
      { id:'apr-1', kind:'commit',    cycle:'b555cca4', requestedBy:'coder',        requestedAt: ts(2),  summary:'Approve merge of item-3 (SSE reconnection) into autonomous/v14.1.0', model:'sonnet', priority:'normal', filesChanged:3, linesAdded:127, linesRemoved:8 },
      { id:'apr-2', kind:'budget',    cycle:'b555cca4', requestedBy:'cto',          requestedAt: ts(8),  summary:'Raise cycle budget from $200 to $300 — execute phase is at 73% with 2 items remaining', model:'opus', priority:'high', filesChanged:0, linesAdded:0, linesRemoved:0 },
      { id:'apr-3', kind:'model',     cycle:'b555cca4', requestedBy:'cto',          requestedAt: ts(18), summary:'Allow opus for item-5 (approval modal) — sonnet failed integration tests twice', model:'opus', priority:'high', filesChanged:0, linesAdded:0, linesRemoved:0 },
    ],

    // ── jobs (durable queue) ──────────────────────────────────────────────
    jobs: [
      { id:'job-cycle-b555cca4', kind:'cycle',     status:'running',   queue:'default', priority:5, attempts:1, dur:'1h 35m', cost:5.89, agent:null,           startedAt: ts(95) },
      { id:'job-runner-7f2a',    kind:'runner',    status:'queued',    queue:'runner',  priority:3, attempts:0, dur:null,     cost:0,    agent:'coder',         startedAt: null },
      { id:'job-bench-4823',     kind:'benchmark', status:'queued',    queue:'low',     priority:1, attempts:0, dur:null,     cost:0,    agent:'benchmark-lead',startedAt: null },
      { id:'job-cycle-21e08f56', kind:'cycle',     status:'completed', queue:'default', priority:5, attempts:1, dur:'24m 32s',cost:2.61, agent:null,           startedAt: ts(240) },
      { id:'job-runner-12a3',    kind:'runner',    status:'completed', queue:'runner',  priority:3, attempts:1, dur:'45s',    cost:0.0151,agent:'ceo',          startedAt: ts(180) },
      { id:'job-cycle-378652a2', kind:'cycle',     status:'failed',    queue:'default', priority:5, attempts:2, dur:'48m 10s',cost:31.61,agent:null,           startedAt: ts(28*1440) },
      { id:'job-cycle-eled9c0e', kind:'cycle',     status:'failed',    queue:'default', priority:5, attempts:1, dur:'49m 20s',cost:25.02,agent:null,           startedAt: ts(27*1440) },
    ],

    // ── audit log (compliance) ────────────────────────────────────────────
    auditLog: [
      { t: ts(2),    actor:'sean.vaughan',     action:'approval.approved',   target:'cycle b555cca4 / commit item-3', ip:'192.168.1.42' },
      { t: ts(8),    actor:'cto',              action:'cycle.budget.raise',  target:'b555cca4 from $200 → $300',      ip:'agent' },
      { t: ts(35),   actor:'sean.vaughan',     action:'cycle.launched',      target:'cycle b555cca4 (sprint v14.1.0)',ip:'192.168.1.42' },
      { t: ts(120),  actor:'sean.vaughan',     action:'workspace.selected',  target:'default',                         ip:'192.168.1.42' },
      { t: ts(180),  actor:'sean.vaughan',     action:'settings.updated',    target:'max_concurrent_agents 20 → 25',   ip:'192.168.1.42' },
      { t: ts(360),  actor:'sean.vaughan',     action:'agent.created',       target:'agent-template-author',           ip:'192.168.1.42' },
      { t: ts(1440), actor:'sean.vaughan',     action:'cycle.approved',      target:'cycle 21e08f56 / commit',         ip:'192.168.1.42' },
      { t: ts(1500), actor:'system',           action:'memory.consolidated', target:'76 entries indexed',              ip:'-' },
    ],

    // ── memory entries (knowledge) ────────────────────────────────────────
    memory: [
      { id:'mem-1', kind:'pattern',  text:'SSE reconnection should use exponential backoff capped at 30s',     source:'cycle b555cca4', agent:'coder',         hits:14, createdAt: ts(7) },
      { id:'mem-2', kind:'failure',  text:'Integration tests fail when keyboard shortcuts use document.addEventListener instead of element-scoped listeners', source:'cycle b555cca4', agent:'backend-qa', hits:3, createdAt: ts(45) },
      { id:'mem-3', kind:'decision', text:'Prefer marked over markdown-it for phase rendering — bundle size 12KB vs 47KB', source:'cycle b555cca4', agent:'coder', hits:8, createdAt: ts(60) },
      { id:'mem-4', kind:'pattern',  text:'Use $derived() in Svelte 5 instead of $: reactive blocks for rune-mode components', source:'cycle 21e08f56', agent:'frontend-engineer', hits:22, createdAt: ts(240) },
      { id:'mem-5', kind:'metric',   text:'Avg cycle cost dropped 18% after switching from opus default to sonnet default for execute phase', source:'cycle 4424e214', agent:'data-analyst', hits:31, createdAt: ts(28*1440) },
      { id:'mem-6', kind:'decision', text:'Cycle budget should be 2.5x the estimated cost to allow for retry headroom', source:'cycle dd3f7c94', agent:'cfo', hits:9, createdAt: ts(45*1440) },
      { id:'mem-7', kind:'failure',  text:'Avoid Fastify schema validation on streaming endpoints — adds 40ms p99 latency', source:'cycle fb07d93a', agent:'api-gateway-engineer', hits:5, createdAt: ts(45*1440) },
      { id:'mem-8', kind:'pattern',  text:'Always run prettier --write before committing — saves 4-7 minutes of review nitpicks', source:'cycle 9a567161', agent:'code-reviewer', hits:18, createdAt: ts(46*1440) },
    ],

    // ── command palette (search/recents) ──────────────────────────────────
    paletteRecents: [
      { kind:'cycle',    label:'b555cca4 — v14.1.0',           href:'/cycles/b555cca4' },
      { kind:'agent',    label:'coder',                          href:'/agents' },
      { kind:'page',     label:'Launch new cycle',               href:'/cycles/new' },
      { kind:'page',     label:'Flywheel',                       href:'/flywheel' },
    ],

    // ── notifications ─────────────────────────────────────────────────────
    notifications: [
      { id:'n-1', kind:'approval', at: ts(2),   title:'Approval needed', body:'cto requested budget increase on b555cca4', unread:true, severity:'warning' },
      { id:'n-2', kind:'cycle',    at: ts(13),  title:'Item completed', body:'item-3 merged into autonomous/v14.1.0',     unread:true, severity:'info' },
      { id:'n-3', kind:'cost',     at: ts(45),  title:'Cost threshold', body:'b555cca4 hit 50% of budget ($100)',          unread:false, severity:'info' },
      { id:'n-4', kind:'cycle',    at: ts(180), title:'Cycle completed', body:'21e08f56 — v14.0.0 — completed cleanly',    unread:false, severity:'success' },
      { id:'n-5', kind:'failure',  at: ts(1440),title:'Cycle failed',    body:'378652a2 — v12.0.0 — tests broke at run',   unread:false, severity:'danger' },
    ],

    // ── insights (cards on insights/reports page) ─────────────────────────
    insights: [
      { id:'i-1', title:'Pass rate up 2.4% week over week',                 detail:'Driven by item-3 retries dropping after exponential backoff was added.', kind:'win',    sparkColor:'#5bd394', spark: trend(14, 96, 99.8, 1.2) },
      { id:'i-2', title:'Sonnet now handles 73% of execute-phase items',   detail:'Cost dropped $4.20/cycle while pass-rate stayed stable.',                kind:'shift',  sparkColor:'#7aa0f7', spark: trend(14, 0.4, 0.73, 0.05) },
      { id:'i-3', title:'Memory hit rate plateaued at 78%',                 detail:'4 weeks flat — candidate for next learning sprint to push past 85%.',   kind:'risk',   sparkColor:'#f5a623', spark: trend(14, 75, 78, 1.5) },
      { id:'i-4', title:'Average review time down 6m',                      detail:'Code-reviewer now batches feedback into one pass per item.',            kind:'win',    sparkColor:'#5bd394', spark: trend(14, 18, 12, 2) },
    ],

    // ── scheduled cycles ──────────────────────────────────────────────────
    schedule: [
      { id:'sch-1', name:'Nightly minor bump',          cron:'0 2 * * *',     budget:50,  enabled:true,  next:'in 14h',  lastRun: ts(600),    pattern:'minor bump from main' },
      { id:'sch-2', name:'Weekly benchmark sweep',      cron:'0 4 * * 1',     budget:200, enabled:true,  next:'in 3d',   lastRun: ts(4*1440), pattern:'run launch-gate benchmarks' },
      { id:'sch-3', name:'Friday dependency audit',     cron:'0 9 * * 5',     budget:80,  enabled:false, next:'paused',  lastRun: ts(7*1440), pattern:'audit + upgrade dependencies' },
      { id:'sch-4', name:'Monthly cost report',          cron:'0 6 1 * *',     budget:25,  enabled:true,  next:'in 17d',  lastRun: ts(30*1440),pattern:'generate cost-report.md' },
    ],

    // ── API keys ──────────────────────────────────────────────────────────
    apiKeys: [
      { id:'k-1', name:'CI runner',           prefix:'af_live_a4f2',   created: ts(30*1440), lastUsed: ts(60),  scopes:['cycles:read','cycles:write','agents:read'] },
      { id:'k-2', name:'Internal dashboard',  prefix:'af_live_b7e1',   created: ts(60*1440), lastUsed: ts(2),   scopes:['*:read'] },
      { id:'k-3', name:'Cost monitor',        prefix:'af_live_c8d3',   created: ts(90*1440), lastUsed: ts(720), scopes:['cost:read','health:read'] },
    ],

    // ── webhooks / integrations ──────────────────────────────────────────
    webhooks: [
      { id:'wh-1', url:'https://hooks.slack.com/services/T0/B0/xxx', events:['cycle.complete','approval.requested'], lastDelivery: ts(13), status:'healthy' },
      { id:'wh-2', url:'https://linear.app/api/agentforge-bridge',   events:['cycle.failed','item.completed'],        lastDelivery: ts(45), status:'healthy' },
      { id:'wh-3', url:'https://datadog.com/api/v1/events',           events:['cycle.*','phase.*'],                     lastDelivery: ts(2),  status:'degraded' },
    ],

    // ── util ───────────────────────────────────────────────────────────────
    spark, trend, ts,
  };
})();
