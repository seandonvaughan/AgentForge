<script lang="ts">
  /**
   * Command Center home page (route `/`).
   *
   * Rebuilt against the v2 prototype design (`design/v2-handoff/prototype/page-cmd-cycles.jsx`
   * CommandCenter component). Composition:
   *
   *   1. Hero panel       — current cycle (or system-idle), large StageRail + quad-stat row.
   *   2. KPI tile strip   — 4 tiles: cost today, tests passing, cycles this week, memory entries.
   *   3. Agent activity   — per-agent cards with sparkline + Codex profile + last-run timestamp.
   *   4. Recent cycles    — last 5–8 cycles, each with StageDots + cost + verdict + relative time.
   *   5. Fleet mix        — DistBar of Codex profile cost mix.
   *
   * Data is loaded by `+page.ts` (universal load: SSR + hydration) and re-fetched
   * client-side every 5s while the tab is visible. All five panels degrade
   * gracefully on empty data, show a skeleton on first load, and show a
   * per-panel "couldn't load — retry" UI on error.
   */
  import { onMount, onDestroy } from 'svelte';
  import {
    AnimNum, Badge, Btn, Card, DistBar, KpiTile,
    PulseDot, Sparkline, StageDots, StageRail,
  } from '$lib/components/v2';
  import { withWorkspace } from '$lib/stores/workspace';
  import type {
    AgentListItem, CommandCenterSnapshot,
    CountersPayload, CycleListRow, SessionRow,
  } from './+page';

  // SvelteKit gives us the load output via `data`
  let { data }: { data: CommandCenterSnapshot } = $props();

  // ── Reactive snapshot (mutated by polling) ─────────────────────────────
  // Seed from the load snapshot. SvelteKit only re-runs `load` on navigation,
  // so `data` is effectively immutable for the lifetime of this page mount —
  // we own `snapshot` and mutate it from the polling functions below.
  let snapshot: CommandCenterSnapshot = $state(data);

  // ── Polling: 5s while visible, paused when tab is hidden ───────────────
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let elapsedHandle: ReturnType<typeof setInterval> | null = null;
  // Tick value used to drive the elapsed-time recompute for the running cycle.
  let nowMs = $state(Date.now());

  async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(withWorkspace(url));
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return (await res.json()) as T;
  }

  async function refreshCycles(): Promise<void> {
    try {
      const json = await fetchJson<{ cycles: CycleListRow[] }>('/api/v5/cycles?limit=8');
      snapshot = { ...snapshot, cycles: json.cycles ?? [], errors: { ...snapshot.errors, cycles: null } };
    } catch (e) {
      snapshot = { ...snapshot, errors: { ...snapshot.errors, cycles: e instanceof Error ? e.message : String(e) } };
    }
  }

  async function refreshCounters(): Promise<void> {
    try {
      const json = await fetchJson<CountersPayload>('/api/v5/counters');
      snapshot = { ...snapshot, counters: json, errors: { ...snapshot.errors, counters: null } };
    } catch (e) {
      snapshot = { ...snapshot, errors: { ...snapshot.errors, counters: e instanceof Error ? e.message : String(e) } };
    }
  }

  async function refreshAgents(): Promise<void> {
    try {
      const json = await fetchJson<{ data: AgentListItem[] }>('/api/v5/agents');
      snapshot = { ...snapshot, agents: json.data ?? [], errors: { ...snapshot.errors, agents: null } };
    } catch (e) {
      snapshot = { ...snapshot, errors: { ...snapshot.errors, agents: e instanceof Error ? e.message : String(e) } };
    }
  }

  async function refreshSessions(): Promise<void> {
    try {
      const json = await fetchJson<{ data: SessionRow[] }>('/api/v5/sessions?limit=100');
      snapshot = { ...snapshot, sessions: json.data ?? [], errors: { ...snapshot.errors, sessions: null } };
    } catch (e) {
      snapshot = { ...snapshot, errors: { ...snapshot.errors, sessions: e instanceof Error ? e.message : String(e) } };
    }
  }

  async function refreshCosts(): Promise<void> {
    try {
      const json = await fetchJson<{ data: CommandCenterSnapshot['costs'] }>('/api/v5/costs/summary');
      snapshot = { ...snapshot, costs: json.data ?? null, errors: { ...snapshot.errors, costs: null } };
    } catch (e) {
      snapshot = { ...snapshot, errors: { ...snapshot.errors, costs: e instanceof Error ? e.message : String(e) } };
    }
  }

  async function refreshMemory(): Promise<void> {
    try {
      const json = await fetchJson<{ meta: { total: number } }>('/api/v5/memory');
      snapshot = { ...snapshot, memoryTotal: json.meta?.total ?? null, errors: { ...snapshot.errors, memory: null } };
    } catch (e) {
      snapshot = { ...snapshot, errors: { ...snapshot.errors, memory: e instanceof Error ? e.message : String(e) } };
    }
  }

  function pollFast(): void {
    void refreshCycles();
    void refreshCounters();
    void refreshSessions();
  }
  function pollSlow(): void {
    void refreshAgents();
    void refreshCosts();
    void refreshMemory();
  }

  let slowCounter = 0;
  function tickPoll(): void {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    pollFast();
    slowCounter += 1;
    if (slowCounter % 6 === 0) pollSlow(); // every ~30s
  }

  onMount(() => {
    pollHandle = setInterval(tickPoll, 5000);
    elapsedHandle = setInterval(() => { nowMs = Date.now(); }, 1000);
  });
  onDestroy(() => {
    if (pollHandle) clearInterval(pollHandle);
    if (elapsedHandle) clearInterval(elapsedHandle);
  });

  // ── Derived data ───────────────────────────────────────────────────────

  /** Stage → macro index mapping (mirrors lib/components/CycleStageBar). */
  const STAGE_MAP: Record<string, number> = {
    plan: 0, audit: 0,
    stage: 1, assign: 1,
    run: 2, execute: 2,
    verify: 3, test: 3,
    commit: 4, review: 4, gate: 4,
    release: 5, learn: 5, completed: 5,
    failed: -1, killed: -1, crashed: -1, unknown: -1,
  };
  const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed', 'crashed']);

  type StageStatus = 'pending' | 'active' | 'done' | 'failed';

  function stagesForCycle(c: CycleListRow): StageStatus[] {
    const key = (c.stage ?? '').toLowerCase();
    const out: StageStatus[] = ['pending', 'pending', 'pending', 'pending', 'pending', 'pending'];
    const isTerminalFail = key === 'failed' || key === 'killed' || key === 'crashed';
    const isTerminalOk = key === 'completed';
    if (isTerminalOk) return out.map(() => 'done') as StageStatus[];
    if (isTerminalFail) {
      out[0] = 'failed';
      return out;
    }
    const idx = STAGE_MAP[key] ?? 0;
    for (let i = 0; i < out.length; i++) {
      if (i < idx) out[i] = 'done';
      else if (i === idx) out[i] = 'active';
    }
    return out;
  }

  function isCycleRunning(c: CycleListRow): boolean {
    const k = (c.stage ?? '').toLowerCase();
    return !TERMINAL_STATUSES.has(k);
  }

  /** First running cycle (or first cycle if none running). */
  const heroCycle = $derived.by<CycleListRow | null>(() => {
    if (snapshot.cycles.length === 0) return null;
    return snapshot.cycles.find(isCycleRunning) ?? snapshot.cycles[0] ?? null;
  });

  const heroIsRunning = $derived.by<boolean>(() => heroCycle != null && isCycleRunning(heroCycle));

  /** Elapsed-time display for the hero (recomputes every second via nowMs). */
  const heroElapsed = $derived.by<string>(() => {
    if (!heroCycle) return '—';
    const startMs = heroCycle.startedAt ? new Date(heroCycle.startedAt).getTime() : 0;
    if (!startMs) return '—';
    const endMs = heroIsRunning
      ? nowMs
      : (heroCycle.completedAt ? new Date(heroCycle.completedAt).getTime() : nowMs);
    const sec = Math.max(0, Math.floor((endMs - startMs) / 1000));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return `${m}m ${s.toString().padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${(m % 60).toString().padStart(2, '0')}m`;
  });

  const heroStages = $derived.by<StageStatus[]>(() => {
    if (!heroCycle) return ['pending', 'pending', 'pending', 'pending', 'pending', 'pending'];
    return stagesForCycle(heroCycle);
  });

  /** Cycles started in the last 7 days. */
  const cyclesThisWeek = $derived.by<number>(() => {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return snapshot.cycles.filter(c => {
      const t = c.startedAt ? new Date(c.startedAt).getTime() : 0;
      return t >= weekAgo;
    }).length;
  });

  /** Sparkline of cycles-per-day over the last 7 days (oldest → newest). */
  const cyclesSparkline = $derived.by<number[]>(() => {
    const buckets = [0, 0, 0, 0, 0, 0, 0];
    const now = Date.now();
    for (const c of snapshot.cycles) {
      const t = c.startedAt ? new Date(c.startedAt).getTime() : 0;
      if (!t) continue;
      const daysAgo = Math.floor((now - t) / (24 * 60 * 60 * 1000));
      if (daysAgo >= 0 && daysAgo < 7) buckets[6 - daysAgo]! += 1;
    }
    return buckets;
  });

  /** Latest cycle's tests-passing percentage (0-100). */
  const testsPct = $derived.by<number>(() => {
    const c = snapshot.cycles[0];
    if (!c || c.testsTotal === 0) return 0;
    return Math.round((c.testsPassed / c.testsTotal) * 1000) / 10;
  });

  /** Sparkline of pass-rate over the last 8 cycles (oldest → newest). */
  const testsSparkline = $derived.by<number[]>(() => {
    const list = [...snapshot.cycles].reverse();
    return list.map(c => c.testsTotal > 0 ? (c.testsPassed / c.testsTotal) * 100 : 0);
  });

  /** Cost-today sparkline: last 7 daily rollups (oldest → newest). */
  const costSparkline = $derived.by<number[]>(() => {
    const list = snapshot.costs?.dailyRollups ?? [];
    return list.slice(-7).map(d => d.costUsd);
  });

  /** Tier of a server `model` string. Map runtime model/profile IDs to capability tier. */
  function tierOf(model: string | null | undefined): 'opus' | 'sonnet' | 'haiku' | 'other' {
    const m = (model ?? '').toLowerCase();
    if (m.includes('gpt-5.5') || m.includes('xhigh')) return 'opus';
    if (m.includes('gpt-5.3-codex') || m.includes('high')) return 'sonnet';
    if (m.includes('gpt-5.4-mini') || m.includes('medium')) return 'haiku';
    if (m.includes('opus')) return 'opus';
    if (m.includes('sonnet')) return 'sonnet';
    if (m.includes('haiku')) return 'haiku';
    return 'other';
  }

  function profileLabel(model: string | null | undefined): string {
    const tier = tierOf(model);
    if (tier === 'opus') return 'gpt-5.5 / xhigh';
    if (tier === 'sonnet') return 'gpt-5.3-codex / high';
    if (tier === 'haiku') return 'gpt-5.4-mini / medium';
    return 'other';
  }

  /** Per-tier cost totals derived from costs.byModel. */
  const tierMix = $derived.by<{ opus: number; sonnet: number; haiku: number; other: number; total: number }>(() => {
    const mix = { opus: 0, sonnet: 0, haiku: 0, other: 0, total: 0 };
    for (const m of snapshot.costs?.byModel ?? []) {
      const t = tierOf(m.model);
      mix[t] += m.costUsd;
      mix.total += m.costUsd;
    }
    return mix;
  });

  /** Per-agent activity rollup from the last ~100 sessions. */
  interface AgentActivity {
    agentId: string;
    name: string;
    declaredModel: string;
    lastRun: number;
    sparkline: number[];
    sessionCount: number;
    totalCostUsd: number;
  }

  const agentActivities = $derived.by<AgentActivity[]>(() => {
    const byAgent = new Map<string, AgentActivity>();
    // Seed from declared agents (so even agents with no sessions appear)
    for (const a of snapshot.agents) {
      byAgent.set(a.agentId, {
        agentId: a.agentId, name: a.name, declaredModel: a.model,
        lastRun: 0, sparkline: new Array<number>(12).fill(0),
        sessionCount: 0, totalCostUsd: 0,
      });
    }
    // Bucket recent sessions into 12 × 2-hour buckets over the last 24h.
    const now = Date.now();
    const bucketSize = 2 * 60 * 60 * 1000;
    const horizon = now - 12 * bucketSize;
    for (const s of snapshot.sessions) {
      let entry = byAgent.get(s.agent_id);
      if (!entry) {
        entry = {
          agentId: s.agent_id, name: s.agent_id, declaredModel: 'sonnet',
          lastRun: 0, sparkline: new Array<number>(12).fill(0),
          sessionCount: 0, totalCostUsd: 0,
        };
        byAgent.set(s.agent_id, entry);
      }
      const t = s.started_at ? new Date(s.started_at).getTime() : 0;
      if (t > entry.lastRun) entry.lastRun = t;
      entry.sessionCount += 1;
      entry.totalCostUsd += s.cost_usd ?? 0;
      if (t >= horizon) {
        const bucket = Math.min(11, Math.max(0, Math.floor((t - horizon) / bucketSize)));
        entry.sparkline[bucket]! += 1;
      }
    }
    // Sort by most-recent activity desc, take top 8.
    return [...byAgent.values()]
      .sort((a, b) => b.lastRun - a.lastRun)
      .slice(0, 8);
  });

  // ── Formatters ─────────────────────────────────────────────────────────
  function fmtDollar(v: number, decimals = 2): string {
    return `$${v.toFixed(decimals)}`;
  }
  function shortId(id: string): string {
    return id.length > 10 ? id.slice(0, 10) : id;
  }
  function fmtRel(then: number): string {
    if (!then) return '—';
    const d = Math.max(0, Math.floor((nowMs - then) / 1000));
    if (d < 60) return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }
  function cycleVerdict(c: CycleListRow): 'completed' | 'failed' | 'running' {
    const k = (c.stage ?? '').toLowerCase();
    if (k === 'completed') return 'completed';
    if (k === 'failed' || k === 'killed' || k === 'crashed') return 'failed';
    return 'running';
  }
  function verdictVariant(v: ReturnType<typeof cycleVerdict>): 'success' | 'danger' | 'purple' {
    return v === 'completed' ? 'success' : v === 'failed' ? 'danger' : 'purple';
  }

  // KPI deltas — compare today's spend to the prior-6-day average.
  const costDelta = $derived.by<string | undefined>(() => {
    const today = snapshot.counters?.todaySpendUsd ?? 0;
    const week = snapshot.counters?.weekSpendUsd ?? 0;
    if (week <= 0) return undefined;
    const avgPriorDays = (week - today) / 6;
    if (avgPriorDays <= 0) return undefined;
    const pct = ((today - avgPriorDays) / avgPriorDays) * 100;
    const rounded = Math.round(pct);
    if (Math.abs(rounded) < 1) return '0%';
    return `${rounded > 0 ? '+' : ''}${rounded}%`;
  });
</script>

<svelte:head><title>Command Center — AgentForge</title></svelte:head>

<!-- ── Page header ─────────────────────────────────────────────────────────── -->
<header class="cc-header">
  <div class="cc-crumbs font-mono">Workspace · Command Center</div>
  <div class="cc-headline-row">
    <h1 class="cc-title">Today&rsquo;s operations</h1>
    <div class="cc-actions">
      <Btn size="sm" href="/cycles">Cycles ▾</Btn>
      <Btn size="sm" variant="purple" href="/cycles/new">+ Launch cycle</Btn>
    </div>
  </div>
  <div class="cc-subtitle">
    {#if snapshot.counters}
      <span class="font-mono">{snapshot.counters.runningCycles}</span> running ·
      <span class="font-mono">{snapshot.counters.agentsActive}</span> agents active ·
      spent <span class="font-mono">{fmtDollar(snapshot.counters.todaySpendUsd)}</span> today ·
      <span class="cc-load cc-load-{snapshot.counters.load}">{snapshot.counters.load}</span>
    {:else if snapshot.errors.counters}
      <span class="cc-section-err">
        couldn&rsquo;t load counters —
        <button class="cc-link-btn" onclick={refreshCounters}>retry</button>
      </span>
    {:else}
      <span class="cc-skel" style="width:240px;height:14px;display:inline-block"></span>
    {/if}
  </div>
</header>

<!-- ── KPI strip ───────────────────────────────────────────────────────────── -->
<section class="cc-kpis">
  <KpiTile
    label="Cost today"
    value={snapshot.counters ? fmtDollar(snapshot.counters.todaySpendUsd) : '—'}
    sub={snapshot.counters ? `${fmtDollar(snapshot.counters.weekSpendUsd)} this week` : ''}
    delta={costDelta}
    color="var(--af-purple)"
    sparkline={costSparkline.length > 1 ? costSparkline : undefined}
  />
  <KpiTile
    label="Tests passing"
    value={snapshot.cycles[0] && snapshot.cycles[0].testsTotal > 0
      ? `${testsPct}%`
      : '—'}
    sub={snapshot.cycles[0] && snapshot.cycles[0].testsTotal > 0
      ? `${snapshot.cycles[0].testsPassed.toLocaleString()} / ${snapshot.cycles[0].testsTotal.toLocaleString()}`
      : 'no cycle data'}
    color={testsPct >= 99 ? 'var(--af-success)' : testsPct >= 90 ? 'var(--af-warning)' : 'var(--af-danger)'}
    sparkline={testsSparkline.length > 1 ? testsSparkline : undefined}
  />
  <KpiTile
    label="Cycles this week"
    value={cyclesThisWeek}
    sub={`${snapshot.cycles.length} loaded`}
    color="var(--af-accent2)"
    sparkline={cyclesSparkline}
  />
  <KpiTile
    label="Memory entries"
    value={snapshot.memoryTotal ?? '—'}
    sub={snapshot.errors.memory ? 'unavailable' : 'across all types'}
    color="var(--af-haiku)"
  />
</section>

<!-- ── Hero panel ──────────────────────────────────────────────────────────── -->
<section class="cc-hero-wrap">
  <Card noPad>
    {#if snapshot.errors.cycles && snapshot.cycles.length === 0}
      <div class="cc-section-err-block">
        Couldn&rsquo;t load cycles —
        <button class="cc-link-btn" onclick={refreshCycles}>retry</button>
      </div>
    {:else if heroCycle}
      <!-- Active or last-completed cycle hero -->
      <div class="cc-hero-head">
        <div class="cc-hero-head-left">
          {#if heroIsRunning}
            <PulseDot color="var(--af-purple)" size={7} />
            <span class="cc-hero-eyebrow cc-hero-eyebrow-active">ACTIVE CYCLE</span>
          {:else}
            <span class="cc-hero-eyebrow cc-hero-eyebrow-idle">LAST CYCLE</span>
          {/if}
          <span class="font-mono cc-hero-id">{shortId(heroCycle.cycleId)}</span>
          {#if heroCycle.sprintVersion}
            <span class="font-mono cc-hero-version">v{heroCycle.sprintVersion}</span>
          {/if}
          <span class="cc-hero-sep">·</span>
          <span class="cc-hero-stage">{heroCycle.stage} phase</span>
        </div>
        <div class="cc-hero-head-right">
          <span class="font-mono cc-hero-elapsed">{heroElapsed}</span>
          <Btn size="sm" href="/cycles/{heroCycle.cycleId}">Logs</Btn>
          <Btn size="sm" variant="purple" href="/cycles/{heroCycle.cycleId}">Open detail →</Btn>
        </div>
      </div>

      <div class="cc-hero-rail">
        <StageRail stages={heroStages} />
      </div>

      <!-- Quad stats row -->
      <div class="cc-hero-quad">
        <div class="cc-quad">
          <div class="cc-quad-label">BUDGET</div>
          <div class="cc-quad-value font-mono">
            <AnimNum value={heroCycle.costUsd} decimals={2} prefix="$" />
          </div>
          <div class="cc-quad-sub">of {fmtDollar(heroCycle.budgetUsd)}</div>
          <div class="cc-quad-bar">
            <div
              class="cc-quad-fill cc-quad-fill-gradient"
              style="width:{Math.min(100, (heroCycle.costUsd / Math.max(1, heroCycle.budgetUsd)) * 100)}%"
            ></div>
          </div>
        </div>
        <div class="cc-quad">
          <div class="cc-quad-label">TESTS</div>
          <div class="cc-quad-value font-mono">
            {heroCycle.testsTotal > 0
              ? `${heroCycle.testsPassed.toLocaleString()}`
              : '—'}
          </div>
          <div class="cc-quad-sub">
            {heroCycle.testsTotal > 0 ? `of ${heroCycle.testsTotal.toLocaleString()} pass` : 'no test data'}
          </div>
          {#if heroCycle.testsTotal > 0}
            <div class="cc-quad-bar">
              <div
                class="cc-quad-fill cc-quad-fill-success"
                style="width:{(heroCycle.testsPassed / heroCycle.testsTotal) * 100}%"
              ></div>
            </div>
          {/if}
        </div>
        <div class="cc-quad">
          <div class="cc-quad-label">DURATION</div>
          <div class="cc-quad-value font-mono">{heroElapsed}</div>
          <div class="cc-quad-sub">
            {heroIsRunning ? 'running' : (heroCycle.completedAt ? 'final' : 'paused')}
          </div>
        </div>
        <div class="cc-quad">
          <div class="cc-quad-label">VERDICT</div>
          <div class="cc-quad-value">
            <Badge variant={verdictVariant(cycleVerdict(heroCycle))}>
              {cycleVerdict(heroCycle)}
            </Badge>
          </div>
          <div class="cc-quad-sub">
            {heroCycle.prUrl ? 'PR opened' : (heroCycle.hasApprovalPending ? 'awaiting approval' : 'no PR')}
          </div>
        </div>
      </div>
    {:else if snapshot.errors.cycles}
      <div class="cc-section-err-block">
        Couldn&rsquo;t load cycles —
        <button class="cc-link-btn" onclick={refreshCycles}>retry</button>
      </div>
    {:else}
      <!-- Idle hero -->
      <div class="cc-hero-idle">
        <div class="cc-hero-idle-eyebrow">SYSTEM STATUS</div>
        <div class="cc-hero-idle-title font-mono">
          <AnimNum value={snapshot.counters?.runningCycles ?? 0} /> running
        </div>
        <div class="cc-hero-idle-sub">
          No cycles in flight. Launch a new cycle to get started.
        </div>
        <div class="cc-hero-idle-cta">
          <Btn variant="purple" href="/cycles/new">+ Launch cycle</Btn>
        </div>
      </div>
    {/if}
  </Card>
</section>

<!-- ── 2-col bottom row: Recent cycles + Right column ──────────────────────── -->
<section class="cc-bottom">
  <!-- Recent cycles -->
  <Card noPad>
    <div class="cc-card-header">
      <span class="cc-section-title">RECENT CYCLES</span>
      <a class="cc-link" href="/cycles">View all →</a>
    </div>
    {#if snapshot.errors.cycles && snapshot.cycles.length === 0}
      <div class="cc-section-err-block">
        Couldn&rsquo;t load cycles —
        <button class="cc-link-btn" onclick={refreshCycles}>retry</button>
      </div>
    {:else if snapshot.cycles.length === 0}
      <div class="cc-empty">No cycles yet. Launch the first one to start the autonomous loop.</div>
    {:else}
      <ul class="cc-cycle-list">
        {#each snapshot.cycles.slice(0, 7) as c (c.cycleId)}
          {@const verdict = cycleVerdict(c)}
          <li>
            <a class="cc-cycle-row" href="/cycles/{c.cycleId}">
              <StageDots stages={stagesForCycle(c)} />
              <span class="font-mono cc-cycle-id">{shortId(c.cycleId)}</span>
              <span class="font-mono cc-cycle-ver">v{c.sprintVersion ?? '—'}</span>
              <span class="font-mono cc-cycle-when">{fmtRel(c.startedAt ? new Date(c.startedAt).getTime() : 0)}</span>
              <span class="font-mono cc-cycle-cost">{fmtDollar(c.costUsd)}</span>
              <Badge variant={verdictVariant(verdict)}>{verdict}</Badge>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </Card>

  <!-- Right column: Agent activity + Fleet mix -->
  <div class="cc-right">
    <!-- Agent activity -->
    <Card>
      <div class="cc-card-header cc-card-header-inline">
        <span class="cc-section-title">LIVE AGENTS</span>
        <PulseDot color="var(--af-success)" size={6} />
      </div>
      {#if snapshot.errors.agents && snapshot.agents.length === 0}
        <div class="cc-section-err-block">
          Couldn&rsquo;t load agents —
          <button class="cc-link-btn" onclick={refreshAgents}>retry</button>
        </div>
      {:else if agentActivities.length === 0}
        <div class="cc-empty">No agents registered yet.</div>
      {:else}
        <ul class="cc-agent-list">
          {#each agentActivities as ag (ag.agentId)}
            <li>
              <a class="cc-agent-row" href="/agents/{ag.agentId}">
                <span
                  class="cc-agent-dot"
                  class:cc-agent-dot-active={ag.lastRun > Date.now() - 60 * 60 * 1000}
                ></span>
                <div class="cc-agent-meta">
                  <div class="cc-agent-name">{ag.name}</div>
                  <div class="cc-agent-sub font-mono">
                    {ag.sessionCount} runs · {fmtRel(ag.lastRun)}
                  </div>
                </div>
                <Sparkline data={ag.sparkline} color="var(--af-purple)" w={50} h={16} />
                <span class="cc-profile-chip font-mono">{profileLabel(ag.declaredModel)}</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>

    <!-- Fleet mix -->
    <Card>
      <div class="cc-card-header cc-card-header-inline">
        <span class="cc-section-title">FLEET MIX</span>
        <span class="font-mono cc-card-meta">{snapshot.costs?.byModel.length ?? 0} runtime profiles</span>
      </div>
      {#if snapshot.errors.costs && !snapshot.costs}
        <div class="cc-section-err-block">
          Couldn&rsquo;t load costs —
          <button class="cc-link-btn" onclick={refreshCosts}>retry</button>
        </div>
      {:else if tierMix.total === 0}
        <div class="cc-empty">No cost data yet.</div>
      {:else}
        <DistBar segments={[
          { value: tierMix.opus,   color: 'var(--af-opus)',   label: `xhigh ${fmtDollar(tierMix.opus)}` },
          { value: tierMix.sonnet, color: 'var(--af-sonnet)', label: `high ${fmtDollar(tierMix.sonnet)}` },
          { value: tierMix.haiku,  color: 'var(--af-haiku)',  label: `medium ${fmtDollar(tierMix.haiku)}` },
          ...(tierMix.other > 0 ? [{ value: tierMix.other, color: 'var(--af-dim)', label: `other ${fmtDollar(tierMix.other)}` }] : []),
        ]} h={6} />
        <div class="cc-tier-legend">
          <span>
            <span class="cc-tier-swatch" style="background:var(--af-opus)"></span>
            <span class="cc-tier-label">xhigh</span>
            <span class="font-mono cc-tier-val">{fmtDollar(tierMix.opus)}</span>
          </span>
          <span>
            <span class="cc-tier-swatch" style="background:var(--af-sonnet)"></span>
            <span class="cc-tier-label">high</span>
            <span class="font-mono cc-tier-val">{fmtDollar(tierMix.sonnet)}</span>
          </span>
          <span>
            <span class="cc-tier-swatch" style="background:var(--af-haiku)"></span>
            <span class="cc-tier-label">medium</span>
            <span class="font-mono cc-tier-val">{fmtDollar(tierMix.haiku)}</span>
          </span>
        </div>
      {/if}
    </Card>
  </div>
</section>

<style>
  /* ── Page header ───────────────────────────────────────────────────────── */
  .cc-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
  }
  .cc-crumbs {
    font-size: 11px;
    color: var(--af-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .cc-headline-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .cc-title {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--af-text);
  }
  .cc-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .cc-subtitle {
    font-size: 12px;
    color: var(--af-muted);
    line-height: 1.4;
  }
  .cc-load { font-weight: 600; }
  .cc-load-idle { color: var(--af-success); }
  .cc-load-busy { color: var(--af-warning); }
  .cc-load-overloaded { color: var(--af-danger); }

  /* ── KPI strip ─────────────────────────────────────────────────────────── */
  .cc-kpis {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 12px;
  }
  @media (max-width: 980px) {
    .cc-kpis { grid-template-columns: repeat(2, 1fr); }
  }

  /* ── Hero panel ────────────────────────────────────────────────────────── */
  .cc-hero-wrap { margin-bottom: 12px; }

  .cc-hero-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--af-border);
    min-height: 50px;
    flex-wrap: wrap;
  }
  .cc-hero-head-left,
  .cc-hero-head-right {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .cc-hero-eyebrow {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
  }
  .cc-hero-eyebrow-active { color: var(--af-purple); }
  .cc-hero-eyebrow-idle { color: var(--af-dim); }
  .cc-hero-id {
    font-size: 13px;
    font-weight: 600;
    color: var(--af-text);
  }
  .cc-hero-version {
    font-size: 11px;
    color: var(--af-dim);
  }
  .cc-hero-sep { color: var(--af-faint); }
  .cc-hero-stage {
    font-size: 11px;
    color: var(--af-muted);
    text-transform: lowercase;
  }
  .cc-hero-elapsed {
    font-size: 13px;
    color: var(--af-text);
    font-weight: 500;
  }
  .cc-hero-rail {
    padding: 18px 16px 14px;
  }
  .cc-hero-quad {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1px;
    background: var(--af-border);
    border-top: 1px solid var(--af-border);
  }
  @media (max-width: 720px) {
    .cc-hero-quad { grid-template-columns: repeat(2, 1fr); }
  }
  .cc-quad {
    padding: 12px 16px;
    background: var(--af-surface);
  }
  .cc-quad-label {
    font-size: 9px;
    color: var(--af-dim);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 6px;
  }
  .cc-quad-value {
    font-size: 16px;
    font-weight: 600;
    color: var(--af-text);
    margin-bottom: 4px;
    letter-spacing: -0.02em;
  }
  .cc-quad-sub {
    font-size: 10px;
    color: var(--af-dim);
  }
  .cc-quad-bar {
    margin-top: 8px;
    height: 2px;
    background: var(--af-border);
    border-radius: 1px;
    overflow: hidden;
  }
  .cc-quad-fill {
    height: 100%;
    transition: width 600ms ease;
  }
  .cc-quad-fill-gradient { background: var(--af-grad-h); }
  .cc-quad-fill-success { background: var(--af-success); }

  .cc-hero-idle {
    padding: 32px 24px;
    text-align: left;
  }
  .cc-hero-idle-eyebrow {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--af-dim);
    margin-bottom: 6px;
  }
  .cc-hero-idle-title {
    font-size: 26px;
    font-weight: 600;
    color: var(--af-text);
    margin-bottom: 6px;
  }
  .cc-hero-idle-sub {
    font-size: 13px;
    color: var(--af-muted);
    margin-bottom: 16px;
    max-width: 480px;
  }
  .cc-hero-idle-cta { display: flex; gap: 8px; }

  /* ── Bottom row ────────────────────────────────────────────────────────── */
  .cc-bottom {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 12px;
  }
  @media (max-width: 980px) {
    .cc-bottom { grid-template-columns: 1fr; }
  }
  .cc-right {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }

  /* ── Card headers ──────────────────────────────────────────────────────── */
  .cc-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--af-border);
  }
  .cc-card-header-inline {
    padding: 0 0 10px;
    border-bottom: 1px solid var(--af-border);
    margin-bottom: 10px;
  }
  .cc-section-title {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    text-transform: uppercase;
  }
  .cc-link {
    font-size: 11px;
    color: var(--af-dim);
    text-decoration: none;
  }
  .cc-link:hover { color: var(--af-accent2); }
  .cc-card-meta {
    font-size: 10px;
    color: var(--af-dim);
  }

  /* ── Cycle list ────────────────────────────────────────────────────────── */
  .cc-cycle-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .cc-cycle-row {
    display: grid;
    grid-template-columns: auto auto 1fr auto auto auto;
    gap: 12px;
    align-items: center;
    padding: 8px 16px;
    border-bottom: 1px solid var(--af-border);
    text-decoration: none;
    color: inherit;
    transition: background 150ms ease;
  }
  .cc-cycle-row:hover { background: var(--af-surface2); }
  .cc-cycle-list li:last-child .cc-cycle-row { border-bottom: none; }
  .cc-cycle-id {
    font-size: 11px;
    color: var(--af-text);
    font-weight: 600;
    min-width: 70px;
  }
  .cc-cycle-ver {
    font-size: 11px;
    color: var(--af-dim);
  }
  .cc-cycle-when {
    font-size: 10px;
    color: var(--af-dim);
    text-align: right;
    min-width: 60px;
  }
  .cc-cycle-cost {
    font-size: 11px;
    color: var(--af-text);
    text-align: right;
    min-width: 60px;
  }

  /* ── Agent list ────────────────────────────────────────────────────────── */
  .cc-agent-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .cc-agent-row {
    display: grid;
    grid-template-columns: auto 1fr auto auto;
    gap: 10px;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid var(--af-border);
    text-decoration: none;
    color: inherit;
  }
  .cc-agent-list li:last-child .cc-agent-row { border-bottom: none; }
  .cc-agent-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--af-border3);
    flex-shrink: 0;
  }
  .cc-agent-dot-active {
    background: var(--af-purple);
    box-shadow: 0 0 6px var(--af-purple);
  }
  .cc-agent-meta { min-width: 0; }
  .cc-agent-name {
    font-size: 12px;
    color: var(--af-text);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cc-agent-sub {
    font-size: 10px;
    color: var(--af-dim);
    margin-top: 1px;
  }
  .cc-profile-chip {
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 7px;
    border: 1px solid color-mix(in srgb, var(--af-purple) 35%, transparent);
    border-radius: 99px;
    background: color-mix(in srgb, var(--af-purple) 8%, transparent);
    color: var(--af-purple);
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
  }

  /* ── Fleet mix legend ──────────────────────────────────────────────────── */
  .cc-tier-legend {
    display: flex;
    justify-content: space-between;
    margin-top: 10px;
    font-size: 10px;
    gap: 6px;
    flex-wrap: wrap;
  }
  .cc-tier-legend > span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .cc-tier-swatch {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
  }
  .cc-tier-label { color: var(--af-muted); }
  .cc-tier-val { color: var(--af-text); }

  /* ── Empty + error + skeleton ──────────────────────────────────────────── */
  .cc-empty {
    font-size: 12px;
    color: var(--af-faint);
    padding: 28px 16px;
    text-align: center;
  }
  .cc-section-err { color: var(--af-danger); }
  .cc-section-err-block {
    color: var(--af-danger);
    padding: 16px;
    font-size: 12px;
  }
  .cc-link-btn {
    background: none;
    border: none;
    color: var(--af-accent2);
    cursor: pointer;
    text-decoration: underline;
    font-size: inherit;
    padding: 0;
  }
  .cc-skel {
    background: linear-gradient(90deg, var(--af-surface) 0%, var(--af-surface2) 50%, var(--af-surface) 100%);
    background-size: 200% 100%;
    animation: cc-skel-anim 1.4s ease-in-out infinite;
    border-radius: 4px;
    vertical-align: middle;
  }
  @keyframes cc-skel-anim {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .cc-skel { animation: none; }
    .cc-quad-fill { transition: none; }
  }
</style>
