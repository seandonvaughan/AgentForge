<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Gauge from '$lib/components/Gauge.svelte';
  import { withWorkspace } from '$lib/stores/workspace';
  import type { PageData } from './$types';

  export let data: PageData;

  interface FlywheelMetric {
    key: string;
    label: string;
    score: number; // 0-100
    description?: string;
  }

  interface FlywheelDebug {
    cycleCount: number;
    meaningfulCycleCount: number;
    completedCycleCount: number;
    sprintCount: number;
    agentCount: number;
    totalItems: number;
    completedItems: number;
    sessionCount?: number;
    satisfiedSessionCount?: number;
  }

  interface CycleEntryPoint {
    cycleId: string;
    count: number;
    startedAt: string;
  }

  interface MemoryStats {
    totalEntries: number;
    entriesPerCycleTrend: CycleEntryPoint[];
    hitRate: number;
  }

  interface FlywheelData {
    metrics: FlywheelMetric[];
    updatedAt?: string;
    overallScore?: number;
    debug?: FlywheelDebug;
    memoryStats?: MemoryStats;
  }

  const DEFAULT_METRICS: FlywheelMetric[] = [
    { key: 'meta_learning', label: 'Meta-Learning', score: 0 },
    { key: 'autonomy', label: 'Autonomy', score: 0 },
    { key: 'inheritance', label: 'Inheritance', score: 0 },
    { key: 'velocity', label: 'Velocity', score: 0 },
  ];

  const METRIC_COLORS: Record<string, string> = {
    meta_learning: '#f5c842',
    autonomy: '#4a9eff',
    inheritance: '#4caf82',
    velocity: '#f5a623',
  };

  // ── State ──────────────────────────────────────────────────────────────────
  // Initialise from the server-side load (eliminates skeleton flash on first
  // paint). The client-side polling below then takes over for live refresh.
  let flywheel: FlywheelData = data.flywheel
    ? {
        metrics: data.flywheel.metrics,
        updatedAt: data.flywheel.updatedAt,
        overallScore: data.flywheel.overallScore,
        debug: data.flywheel.debug,
        memoryStats: data.flywheel.memoryStats,
      }
    : { metrics: DEFAULT_METRICS };
  let loading = !data.flywheel; // skip skeleton when server data is available
  let error: string | null = null;

  // Auto-refresh: backend caches for 30s so we match that cadence.
  const REFRESH_INTERVAL_MS = 30_000;
  let refreshIn = REFRESH_INTERVAL_MS / 1000; // seconds until next poll
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  // Trend tracking: compare previous load's scores to detect movement.
  let prevScores: Record<string, number> = {};
  // Seed currScores from SSR data so the first client refresh can detect trends.
  let currScores: Record<string, number> = data.flywheel
    ? Object.fromEntries(data.flywheel.metrics.map(m => [m.key, m.score]))
    : {};
  // hasPrevData becomes true once we have SSR data OR after the first API poll.
  let hasPrevData = Boolean(data.flywheel);

  // ── Data loading ───────────────────────────────────────────────────────────
  async function load() {
    // Don't show full-page loader on background refreshes — preserve UX.
    if (!hasPrevData) loading = true;
    error = null;
    try {
      const res = await fetch(withWorkspace('/api/v5/flywheel'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const raw = json.data ?? json;

      // Snapshot previous scores before overwriting
      prevScores = { ...currScores };

      if (Array.isArray(raw)) {
        flywheel = { metrics: raw };
      } else {
        flywheel = {
          metrics: raw.metrics ?? DEFAULT_METRICS,
          updatedAt: raw.updatedAt,
          overallScore: raw.overallScore,
          debug: raw.debug,
          memoryStats: raw.memoryStats,
        };
      }

      // Update current score snapshot and trend flag
      currScores = Object.fromEntries(flywheel.metrics.map(m => [m.key, m.score]));
      if (hasPrevData) {
        // Trend arrows visible after second+ load
      }
      hasPrevData = true;
      refreshIn = REFRESH_INTERVAL_MS / 1000;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  function startTimers() {
    refreshTimer = setInterval(load, REFRESH_INTERVAL_MS);
    countdownTimer = setInterval(() => {
      refreshIn = Math.max(0, refreshIn - 1);
    }, 1_000);
  }

  function stopTimers() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  async function manualRefresh() {
    stopTimers();
    await load();
    startTimers();
  }

  onMount(() => { load().then(startTimers); });
  onDestroy(stopTimers);

  // ── Derived values ─────────────────────────────────────────────────────────
  $: displayMetrics = flywheel.metrics.length > 0 ? flywheel.metrics : DEFAULT_METRICS;
  $: overallScore = flywheel.overallScore ??
    (displayMetrics.length > 0
      ? Math.round(displayMetrics.reduce((s, m) => s + m.score, 0) / displayMetrics.length)
      : 0);

  // Determine score trend direction for each metric (only after a refresh)
  function getTrend(key: string): 'up' | 'down' | 'flat' {
    if (!hasPrevData || prevScores[key] === undefined) return 'flat';
    const delta = (currScores[key] ?? 0) - (prevScores[key] ?? 0);
    if (delta > 0) return 'up';
    if (delta < 0) return 'down';
    return 'flat';
  }

  function getDelta(key: string): number {
    if (!hasPrevData || prevScores[key] === undefined) return 0;
    return (currScores[key] ?? 0) - (prevScores[key] ?? 0);
  }

  // Summary stat rows derived from debug payload
  $: statRows = flywheel.debug ? [
    { label: 'Cycles run', value: flywheel.debug.cycleCount, sub: `${flywheel.debug.completedCycleCount} completed` },
    { label: 'Sprint iterations', value: flywheel.debug.sprintCount, sub: null },
    { label: 'Agents on team', value: flywheel.debug.agentCount, sub: null },
    { label: 'Sprint items', value: `${flywheel.debug.completedItems} / ${flywheel.debug.totalItems}`, sub: flywheel.debug.totalItems > 0 ? `${Math.round(flywheel.debug.completedItems / flywheel.debug.totalItems * 100)}% done` : null },
    ...(flywheel.debug.sessionCount !== undefined
      ? [{ label: 'Sessions run', value: `${flywheel.debug.satisfiedSessionCount ?? 0} / ${flywheel.debug.sessionCount}`, sub: flywheel.debug.sessionCount > 0 ? `${Math.round((flywheel.debug.satisfiedSessionCount ?? 0) / flywheel.debug.sessionCount * 100)}% satisfied` : null }]
      : []),
  ] : [];

  // Empty-state explanation based on debug data
  $: emptyReason = (() => {
    const d = flywheel.debug;
    if (!d) return null;
    if (d.cycleCount === 0 && d.sprintCount === 0 && d.agentCount === 0) {
      return 'No cycle, sprint, or agent data found. Run a cycle to seed the flywheel.';
    }
    if (d.cycleCount > 0 && d.completedCycleCount === 0) {
      return `${d.cycleCount} cycle${d.cycleCount === 1 ? '' : 's'} started but none completed. Autonomy score will rise once a cycle finishes.`;
    }
    return null;
  })();

  // Whether any metric has a non-zero score
  $: hasRealData = displayMetrics.some(m => m.score > 0);

  // Memory stats card
  $: memStats = flywheel.memoryStats;
  $: memHitPct = memStats ? Math.round(memStats.hitRate * 100) : 0;
  $: memTrendMax = memStats
    ? Math.max(1, ...memStats.entriesPerCycleTrend.map(p => p.count))
    : 1;

  // Data source context line shown beneath the header
  $: contextLine = (() => {
    const d = flywheel.debug;
    if (!d) return null;
    const parts: string[] = [];
    if (d.cycleCount > 0) parts.push(`${d.cycleCount} cycle${d.cycleCount === 1 ? '' : 's'}`);
    if (d.sprintCount > 0) parts.push(`${d.sprintCount} sprint${d.sprintCount === 1 ? '' : 's'}`);
    if (d.sessionCount !== undefined && d.sessionCount > 0) parts.push(`${d.sessionCount} session${d.sessionCount === 1 ? '' : 's'}`);
    if (d.agentCount > 0) parts.push(`${d.agentCount} agent${d.agentCount === 1 ? '' : 's'}`);
    return parts.length > 0 ? `Computed from ${parts.join(', ')}` : 'No data sources detected yet';
  })();
</script>

<svelte:head><title>Flywheel — AgentForge</title></svelte:head>

<div class="page-header">
  <div class="header-main">
    <h1 class="page-title">Flywheel</h1>
    <p class="page-subtitle">Autonomous loop health — computed from cycles, sprints &amp; sessions</p>
    {#if contextLine && !loading}
      <p class="context-line">{contextLine}</p>
    {/if}
  </div>
  <div class="header-aside">
    {#if !loading && !error}
      <div class="overall-score">
        <div class="overall-value" class:score-zero={overallScore === 0}>{overallScore}%</div>
        <div class="overall-label">Overall</div>
      </div>
    {/if}
    <div class="refresh-info">
      <button
        class="btn btn-ghost btn-sm refresh-btn"
        onclick={manualRefresh}
        title="Force refresh"
        aria-label="Refresh flywheel data"
      >
        <svg class="refresh-icon" class:spinning={loading} viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.06-3.28" stroke-linecap="round"/>
          <path d="M10 4.5h3V1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Refresh
      </button>
      {#if !loading}
        <span class="refresh-countdown" title="Next auto-refresh">
          Next in {refreshIn}s
        </span>
      {:else}
        <span class="refresh-loading">Loading…</span>
      {/if}
    </div>
  </div>
</div>

{#if loading && !hasPrevData}
  <!-- Full-page skeleton only on first load -->
  <div class="gauges-grid">
    {#each Array(4) as _}
      <div class="card metric-card">
        <div class="skeleton" style="height: 110px; width: 100px; margin: 0 auto var(--space-3);"></div>
        <div class="skeleton" style="height: 14px; width: 60%; margin: 0 auto var(--space-2);"></div>
        <div class="skeleton" style="height: 12px; width: 80%; margin: 0 auto;"></div>
      </div>
    {/each}
  </div>
{:else if error}
  <div class="empty-state">
    <p>Failed to load flywheel data: <code>{error}</code></p>
    <button class="btn btn-ghost btn-sm" style="margin-top: var(--space-3)" onclick={manualRefresh}>Retry</button>
  </div>
{:else}
  <!-- ── Metric Gauges ──────────────────────────────────────────────────────── -->
  <div class="gauges-grid">
    {#each displayMetrics as metric (metric.key)}
      {@const trend = getTrend(metric.key)}
      {@const delta = getDelta(metric.key)}
      <div class="card metric-card" class:metric-card--zero={metric.score === 0 && hasRealData}>
        <Gauge
          value={Math.round(metric.score)}
          label={metric.label}
          color={METRIC_COLORS[metric.key] ?? 'var(--color-brand)'}
        />
        {#if hasPrevData && trend !== 'flat'}
          <div class="trend-badge" class:trend-up={trend === 'up'} class:trend-down={trend === 'down'}>
            {trend === 'up' ? '▲' : '▼'} {Math.abs(delta)}pt
          </div>
        {/if}
        {#if metric.description}
          <p class="metric-desc">{metric.description}</p>
        {/if}
      </div>
    {/each}
  </div>

  <!-- ── Empty-state guidance ────────────────────────────────────────────── -->
  {#if !hasRealData && emptyReason}
    <div class="guidance-banner">
      <span class="guidance-icon">ℹ</span>
      <span>{emptyReason}</span>
    </div>
  {/if}

  <!-- ── Loop Data stats panel ─────────────────────────────────────────── -->
  {#if statRows.length > 0}
    <div class="card stats-card">
      <h2 class="stats-title">Loop Data</h2>
      <dl class="stats-grid">
        {#each statRows as row}
          <div class="stat-row">
            <dt class="stat-label">{row.label}</dt>
            <dd class="stat-value">{row.value}</dd>
            {#if row.sub}
              <dd class="stat-sub">{row.sub}</dd>
            {/if}
          </div>
        {/each}
      </dl>
    </div>
  {/if}

  <!-- ── Memory stats card ──────────────────────────────────────────────── -->
  {#if memStats}
    <div class="card memory-card" data-testid="memory-stats-card">
      <h2 class="stats-title">Memory</h2>
      <dl class="stats-grid">
        <div class="stat-row">
          <dt class="stat-label">Total entries</dt>
          <dd class="stat-value">{memStats.totalEntries}</dd>
        </div>
        <div class="stat-row">
          <dt class="stat-label">Hit rate</dt>
          <dd class="stat-value hit-rate" class:hit-rate--active={memHitPct > 0}>
            {memHitPct}%
          </dd>
          {#if memHitPct > 0}
            <dd class="stat-sub">cycles with prior context</dd>
          {:else if memStats.totalEntries === 0}
            <dd class="stat-sub">no memory written yet</dd>
          {:else}
            <dd class="stat-sub">no cycles started after first entry</dd>
          {/if}
        </div>
        <div class="stat-row trend-row">
          <dt class="stat-label">Entries per cycle</dt>
          <dd class="trend-bars" aria-label="Entries per cycle trend">
            {#if memStats.entriesPerCycleTrend.length === 0}
              <span class="trend-empty">—</span>
            {:else}
              {#each memStats.entriesPerCycleTrend as point (point.cycleId)}
                <span
                  class="trend-bar"
                  style="height: {Math.round((point.count / memTrendMax) * 40) + 4}px"
                  title="{point.cycleId.slice(0, 8)}: {point.count} {point.count === 1 ? 'entry' : 'entries'}"
                ></span>
              {/each}
            {/if}
          </dd>
        </div>
      </dl>
    </div>
  {/if}

  {#if flywheel.updatedAt}
    <p class="updated-at">
      Computed at {new Date(flywheel.updatedAt).toLocaleString()} ·
      auto-refreshes every {REFRESH_INTERVAL_MS / 1000}s
    </p>
  {/if}
{/if}

<style>
  /* ── Page header ──────────────────────────────────────────────────────────── */
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-6);
  }
  .header-main {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .header-aside {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-2);
  }
  .context-line {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    margin: 0;
  }

  /* ── Gauges grid ──────────────────────────────────────────────────────────── */
  .gauges-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: var(--space-5);
    margin-bottom: var(--space-6);
  }
  .metric-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-6) var(--space-5);
    position: relative;
  }
  /* Dim cards where score is 0 while others have data — signals "no input" clearly */
  .metric-card--zero {
    opacity: 0.55;
  }
  .metric-desc {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-align: center;
    margin: 0;
    line-height: 1.5;
  }

  /* ── Trend badge ──────────────────────────────────────────────────────────── */
  .trend-badge {
    font-size: 10px;
    font-family: var(--font-mono);
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 99px;
    letter-spacing: 0.04em;
  }
  .trend-up {
    background: color-mix(in srgb, #4caf82 15%, transparent);
    color: #4caf82;
  }
  .trend-down {
    background: color-mix(in srgb, #f5a623 15%, transparent);
    color: #f5a623;
  }

  /* ── Overall score badge ─────────────────────────────────────────────────── */
  .overall-score {
    text-align: center;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-3) var(--space-5);
  }
  .overall-value {
    font-family: var(--font-mono);
    font-size: var(--text-2xl);
    font-weight: 700;
    color: var(--color-brand);
  }
  .overall-value.score-zero {
    color: var(--color-text-muted);
  }
  .overall-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.07em;
  }

  /* ── Refresh controls ────────────────────────────────────────────────────── */
  .refresh-info {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .refresh-btn {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
  }
  .refresh-icon {
    flex-shrink: 0;
    transition: transform 0.4s ease;
  }
  .refresh-icon.spinning {
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  .refresh-countdown {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    font-variant-numeric: tabular-nums;
    min-width: 70px; /* prevent layout shift as counter changes */
  }
  .refresh-loading {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
  }

  /* ── Guidance banner (zero-state explanation) ────────────────────────────── */
  .guidance-banner {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    margin-bottom: var(--space-5);
    line-height: 1.5;
  }
  .guidance-icon {
    flex-shrink: 0;
    font-size: var(--text-base);
    color: var(--color-brand);
  }

  /* ── Updated-at footer ───────────────────────────────────────────────────── */
  .updated-at {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    margin-top: var(--space-2);
  }

  /* ── Loop Data stats panel ───────────────────────────────────────────────── */
  .stats-card {
    margin-bottom: var(--space-4);
    padding: var(--space-5) var(--space-6);
  }
  .stats-title {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.07em;
    margin: 0 0 var(--space-4);
  }
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: var(--space-3) var(--space-5);
    margin: 0;
  }
  .stat-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .stat-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .stat-value {
    font-family: var(--font-mono);
    font-size: var(--text-lg);
    font-weight: 700;
    color: var(--color-text);
    margin: 0;
  }
  .stat-sub {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    margin: 0;
  }

  /* ── Memory stats card ───────────────────────────────────────────────────── */
  .memory-card {
    margin-bottom: var(--space-4);
    padding: var(--space-5) var(--space-6);
  }
  .hit-rate--active {
    color: var(--color-success, #4caf82);
  }
  .trend-row {
    grid-column: 1 / -1;
  }
  .trend-bars {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 48px;
    margin: 0;
    padding-top: var(--space-1);
  }
  .trend-bar {
    width: 10px;
    min-height: 4px;
    background: var(--color-brand, #4a9eff);
    border-radius: 2px 2px 0 0;
    opacity: 0.75;
    transition: opacity 0.15s;
  }
  .trend-bar:hover {
    opacity: 1;
  }
  .trend-empty {
    font-size: var(--text-sm);
    color: var(--color-text-faint);
    line-height: 48px;
  }
</style>
