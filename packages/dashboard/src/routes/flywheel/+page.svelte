<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Gauge from '$lib/components/Gauge.svelte';
  import { withWorkspace } from '$lib/stores/workspace';
  import type { PageData } from './$types';
  // Import shared types from the server load so they stay in sync automatically.
  // Using `import type` ensures these are erased at runtime (no server-module leakage).
  import type {
    FlywheelMetric,
    FlywheelDebug,
    CycleEntryPoint,
    MemoryStats,
    CycleHistoryPoint,
  } from './+page.server';

  export let data: PageData;

  /** Component-local composed state shape (not exported from the server load). */
  interface FlywheelData {
    metrics: FlywheelMetric[];
    updatedAt?: string;
    overallScore?: number;
    debug?: FlywheelDebug;
    memoryStats?: MemoryStats;
    cycleHistory?: CycleHistoryPoint[];
  }

  const DEFAULT_METRICS: FlywheelMetric[] = [
    { key: 'meta_learning', label: 'Meta-Learning', score: 0 },
    { key: 'autonomy', label: 'Autonomy', score: 0 },
    { key: 'inheritance', label: 'Inheritance', score: 0 },
    { key: 'velocity', label: 'Velocity', score: 0 },
  ];

  // Colors map to CSS custom properties so they respect the active theme.
  // Using getComputedStyle at render time lets SVG gauges pick up the
  // resolved value while the string 'var(--…)' is safe for inline styles.
  const METRIC_COLORS: Record<string, string> = {
    meta_learning: 'var(--color-opus)',
    autonomy: 'var(--color-info)',
    inheritance: 'var(--color-success)',
    velocity: 'var(--color-warning)',
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
        cycleHistory: data.flywheel.cycleHistory,
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
          cycleHistory: raw.cycleHistory,
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
  // Health classification for color coding and the status badge
  $: memHealthLevel = memHitPct >= 70 ? 'active' : memHitPct >= 40 ? 'partial' : memHitPct > 0 ? 'weak' : 'none';
  $: memBadgeLabel  = memHealthLevel === 'active' ? 'ACTIVE' : memHealthLevel === 'partial' ? 'PARTIAL' : memHealthLevel === 'weak' ? 'WEAK' : 'NO DATA';
  $: memHitSubtext  = memHitPct >= 70  ? '✓ learning is compounding'
                    : memHitPct >= 40  ? '~ partial coverage'
                    : memHitPct >  0   ? '⚠ low coverage'
                    : (memStats?.totalEntries ?? 0) === 0 ? 'no memory written yet'
                    : 'no cycles run after first entry';
  /** Bar opacity: newest bars are fully opaque; oldest fade to 0.3. */
  function barOpacity(idx: number, total: number): number {
    return total <= 1 ? 0.75 : 0.3 + 0.7 * ((idx + 1) / total);
  }

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

  // ── Cycle history derived state ─────────────────────────────────────────────
  $: cycleHistory = flywheel.cycleHistory ?? [];
  $: passRateMax = cycleHistory.length > 0
    ? Math.max(...cycleHistory.map(c => c.testPassRate ?? 0), 0.01)
    : 1;
  // Format duration into human-readable string
  function fmtDuration(ms: number | null): string {
    if (ms == null) return '—';
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
  }
  // Map stage to a CSS variable so trajectory bars respect theme overrides.
  function stageColor(stage: string): string {
    if (stage === 'completed') return 'var(--color-success)';
    if (stage === 'running')   return 'var(--color-info)';
    if (stage === 'failed')    return 'var(--color-danger)';
    return 'var(--color-text-muted)';
  }
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

  <!-- Memory stats skeleton — preserves layout so page doesn't reflow when data arrives -->
  <div class="card memory-card" aria-busy="true" aria-label="Loading memory stats">
    <div class="memory-card-header">
      <div class="skeleton" style="height: 16px; width: 180px;"></div>
      <div class="skeleton" style="height: 20px; width: 60px; border-radius: 99px;"></div>
    </div>
    <dl class="stats-grid memory-stats-grid">
      <div class="stat-row">
        <div class="skeleton" style="height: 11px; width: 80px; margin-bottom: var(--space-1);"></div>
        <div class="skeleton" style="height: 28px; width: 60px;"></div>
        <div class="skeleton" style="height: 10px; width: 100px; margin-top: 2px;"></div>
      </div>
      <div class="stat-row">
        <div class="skeleton" style="height: 11px; width: 110px; margin-bottom: var(--space-1);"></div>
        <div class="skeleton" style="height: 28px; width: 52px;"></div>
        <div class="skeleton" style="height: 10px; width: 130px; margin-top: 2px;"></div>
      </div>
      <div class="stat-row trend-row">
        <div class="skeleton" style="height: 11px; width: 130px; margin-bottom: var(--space-2);"></div>
        <div class="skeleton-sparkline">
          {#each Array(8) as _, i}
            <div class="skeleton-spark-bar" style="height: {12 + (i % 3) * 10}px;"></div>
          {/each}
        </div>
      </div>
    </dl>
  </div>
{:else if error && !hasPrevData}
  <!-- Full-page error only when we have no SSR or previous API data at all.
       When hasPrevData is true the SSR-rendered content stays visible and the
       refresh failure is shown as a non-blocking banner inside the {:else} block. -->
  <div class="empty-state">
    <p>Failed to load flywheel data: <code>{error}</code></p>
    <button class="btn btn-ghost btn-sm" style="margin-top: var(--space-3)" onclick={manualRefresh}>Retry</button>
  </div>
{:else}
  <!-- ── Non-blocking refresh error banner ──────────────────────────────────
       Shows when a background API poll fails but SSR data is still valid.
       The memory card and all other content remain visible underneath. -->
  {#if error && hasPrevData}
    <div class="refresh-error-banner" role="alert">
      <span class="refresh-error-icon">⚠</span>
      <span class="refresh-error-msg">Live refresh failed — showing last known data.</span>
      <button class="btn btn-ghost btn-sm refresh-error-retry" onclick={manualRefresh}>Retry</button>
    </div>
  {/if}

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
        {#if metric.trend}
          <!-- Persistent trend direction derived from multi-cycle pass-rate history,
               distinct from the score-delta badge which only tracks cross-refresh changes. -->
          <div class="meta-trend-pill meta-trend-pill--{metric.trend}"
               title="Based on test pass-rate history across cycles">
            {metric.trend === 'improving' ? '↑' : metric.trend === 'declining' ? '↓' : '→'}
            {metric.trend}
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
    <div class="card memory-card" data-testid="memory-stats-card" aria-label="Memory loop health">
      <div class="memory-card-header">
        <h2 class="stats-title" style="margin:0">🧠 Memory Loop Health</h2>
        <span class="mem-badge mem-badge--{memHealthLevel}" data-testid="memory-health-badge">
          {memBadgeLabel}
        </span>
      </div>
      <dl class="stats-grid memory-stats-grid">
        <!-- Total entries -->
        <div class="stat-row">
          <dt class="stat-label">Total entries</dt>
          <dd class="stat-value mem-total" data-testid="mem-total">{memStats.totalEntries}</dd>
          <dd class="stat-sub">across all cycles</dd>
        </div>

        <!-- Hit rate -->
        <div class="stat-row">
          <dt class="stat-label">Memory hit rate</dt>
          <dd class="stat-value mem-hitrate mem-hitrate--{memHealthLevel}" data-testid="mem-hitrate">
            {memHitPct}%
          </dd>
          <dd class="stat-sub">{memHitSubtext}</dd>
        </div>

        <!-- Entries-per-cycle sparkline -->
        <div class="stat-row trend-row">
          <dt class="stat-label">
            Entries per cycle
            {#if memStats.entriesPerCycleTrend.length > 0}
              <span class="trend-cycle-count">({memStats.entriesPerCycleTrend.length})</span>
            {/if}
          </dt>
          <dd class="trend-bars" aria-label="Entries per cycle trend">
            {#if memStats.entriesPerCycleTrend.length === 0}
              <span class="trend-empty">no cycle data yet</span>
            {:else}
              {#each memStats.entriesPerCycleTrend as point, idx (point.cycleId)}
                <span
                  class="trend-bar"
                  style="height: {Math.max(4, Math.round((point.count / memTrendMax) * 40))}px; opacity: {barOpacity(idx, memStats.entriesPerCycleTrend.length)}"
                  title="{point.cycleId.slice(0, 8)}: {point.count} {point.count === 1 ? 'entry' : 'entries'}"
                ></span>
              {/each}
            {/if}
          </dd>
        </div>
      </dl>

      <!-- Link to full memory browser -->
      <div class="memory-card-footer">
        <a href="/memory" class="mem-link">View all memory entries →</a>
      </div>
    </div>
  {:else}
    <!-- Empty state: memoryStats absent from API response or SSR load failed.
         Shown instead of silently hiding the section so operators understand
         why memory metrics aren't appearing. -->
    <div class="card memory-card memory-card--empty" data-testid="memory-stats-card-empty">
      <div class="memory-card-header">
        <h2 class="stats-title" style="margin:0">🧠 Memory Loop Health</h2>
        <span class="mem-badge mem-badge--none">NO DATA</span>
      </div>
      <p class="memory-empty-msg">
        Memory stats unavailable — the memory API may not be reachable, or no
        <code>.agentforge/memory/*.jsonl</code> files exist yet.
      </p>
      <div class="memory-card-footer">
        <a href="/memory" class="mem-link">Open memory browser →</a>
      </div>
    </div>
  {/if}

  <!-- ── Cycle Score Trajectory ────────────────────────────────────────────── -->
  {#if cycleHistory.length > 0}
    <div class="card trajectory-card" data-testid="cycle-history-panel">
      <div class="trajectory-header">
        <h2 class="stats-title" style="margin:0">📈 Score Trajectory</h2>
        <span class="trajectory-subtitle">
          Test pass rate &amp; completion status per cycle · autonomy + velocity inputs
        </span>
      </div>

      <!-- Sparkline bar chart — one bar per cycle, height = test pass rate -->
      <div class="trajectory-chart" aria-label="Cycle test pass rate history">
        {#each cycleHistory as point, idx (point.cycleId)}
          {@const heightPct = point.testPassRate != null
            ? Math.max(4, Math.round((point.testPassRate / passRateMax) * 100))
            : 4}
          {@const passLabel = point.testPassRate != null
            ? `${Math.round(point.testPassRate * 100)}%`
            : 'no tests'}
          {@const color = stageColor(point.stage)}
          {@const opacity = 0.35 + 0.65 * ((idx + 1) / cycleHistory.length)}
          <div
            class="trajectory-col"
            title="{point.sprintVersion ? 'v' + point.sprintVersion : point.cycleId.slice(0, 8)} · {point.stage} · pass rate {passLabel} · cost {point.costUsd != null ? '$' + point.costUsd.toFixed(2) : '—'} · {fmtDuration(point.durationMs)}"
          >
            <div class="trajectory-passrate-label" style="color: {color}">
              {passLabel}
            </div>
            <div class="trajectory-bar-wrap">
              <div
                class="trajectory-bar"
                style="height: {heightPct}%; background: {color}; opacity: {opacity}"
                class:trajectory-bar--pr={point.hasPr}
              ></div>
            </div>
            <div class="trajectory-ver">
              {point.sprintVersion ? 'v' + point.sprintVersion : point.cycleId.slice(0, 6)}
            </div>
          </div>
        {/each}
      </div>

      <!-- Compact table view of cycle history -->
      <div class="trajectory-table-wrap">
        <table class="trajectory-table">
          <thead>
            <tr>
              <th>Sprint</th>
              <th>Stage</th>
              <th>Pass Rate</th>
              <th>Cost</th>
              <th>Duration</th>
              <th>PR</th>
            </tr>
          </thead>
          <tbody>
            {#each [...cycleHistory].reverse() as point (point.cycleId)}
              <tr>
                <td class="cy-sprint">
                  {point.sprintVersion ? 'v' + point.sprintVersion : point.cycleId.slice(0, 8) + '…'}
                </td>
                <td>
                  <span class="cy-stage" style="color: {stageColor(point.stage)}">
                    {point.stage}
                  </span>
                </td>
                <td class="cy-mono">
                  {point.testPassRate != null ? Math.round(point.testPassRate * 100) + '%' : '—'}
                  {#if point.testsTotal != null}
                    <span class="cy-sub">({point.testsTotal} tests)</span>
                  {/if}
                </td>
                <td class="cy-mono">
                  {point.costUsd != null ? '$' + point.costUsd.toFixed(2) : '—'}
                </td>
                <td class="cy-mono">{fmtDuration(point.durationMs)}</td>
                <td class="cy-mono">{point.hasPr ? '✓' : '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
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

  /* ── Score-delta trend badge (▲/▼ Npt — shows cross-refresh change) ─────── */
  .trend-badge {
    font-size: 10px;
    font-family: var(--font-mono);
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 99px;
    letter-spacing: 0.04em;
  }
  .trend-up {
    background: color-mix(in srgb, var(--color-success) 15%, transparent);
    color: var(--color-success);
  }
  .trend-down {
    background: color-mix(in srgb, var(--color-warning) 15%, transparent);
    color: var(--color-warning);
  }

  /* ── Meta-trend pill (↑/→/↓ improving/stable/declining — multi-cycle signal) */
  /* Visually distinct from score-delta badge: lowercase text, lighter weight,
     softer colors so operators don't confuse "meta_learning is improving" with
     "score went up since last page refresh". */
  .meta-trend-pill {
    font-size: 10px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 99px;
    letter-spacing: 0.03em;
    border: 1px solid currentColor;
    opacity: 0.75;
  }
  .meta-trend-pill--improving {
    color: var(--color-success);
    background: color-mix(in srgb, var(--color-success) 10%, transparent);
  }
  .meta-trend-pill--stable {
    color: var(--color-text-muted);
    background: color-mix(in srgb, var(--color-text-muted) 10%, transparent);
  }
  .meta-trend-pill--declining {
    color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 10%, transparent);
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

  /* ── Non-blocking refresh error banner ──────────────────────────────────── */
  /* Shown when a background API poll fails but SSR data is still visible.
     Deliberately subtle — a stale-data warning, not a page-level failure. */
  .refresh-error-banner {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    background: color-mix(in srgb, var(--color-warning) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-warning) 35%, transparent);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin-bottom: var(--space-4);
  }
  .refresh-error-icon {
    flex-shrink: 0;
    color: var(--color-warning);
  }
  .refresh-error-msg {
    flex: 1;
  }
  .refresh-error-retry {
    flex-shrink: 0;
    font-size: var(--text-xs);
    padding: 2px 8px;
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
  .memory-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-4);
  }
  .memory-stats-grid {
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  }

  /* Empty state variant */
  .memory-card--empty {
    opacity: 0.75;
  }
  .memory-empty-msg {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    margin: 0 0 var(--space-3);
    line-height: 1.55;
  }
  .memory-empty-msg code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-surface-2);
    border-radius: var(--radius-sm);
    padding: 1px 4px;
  }

  /* ── Skeleton sparkline (used in memory card loading state) ──────────────── */
  .skeleton-sparkline {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 48px;
    padding-top: var(--space-1);
    margin: 0;
  }
  .skeleton-spark-bar {
    width: 10px;
    border-radius: 2px 2px 0 0;
    background: var(--color-skeleton, color-mix(in srgb, var(--color-border) 60%, transparent));
    animation: skeleton-pulse 1.4s ease-in-out infinite;
  }
  .skeleton-spark-bar:nth-child(2n) {
    animation-delay: 0.2s;
  }
  .skeleton-spark-bar:nth-child(3n) {
    animation-delay: 0.4s;
  }
  @keyframes skeleton-pulse {
    0%, 100% { opacity: 0.45; }
    50% { opacity: 0.9; }
  }

  /* ── Health badge ─────────────────────────────────────────────────────────── */
  .mem-badge {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 3px 10px;
    border-radius: 99px;
    border: 1px solid currentColor;
    text-transform: uppercase;
  }
  .mem-badge--active  { color: var(--color-success); }
  .mem-badge--partial { color: var(--color-opus); }
  .mem-badge--weak    { color: var(--color-warning); }
  .mem-badge--none    { color: var(--color-text-faint); }

  /* ── Total entries ────────────────────────────────────────────────────────── */
  .mem-total {
    color: var(--color-brand);
  }

  /* ── Hit rate color tiers ─────────────────────────────────────────────────── */
  .mem-hitrate--active  { color: var(--color-success); }
  .mem-hitrate--partial { color: var(--color-opus); }
  .mem-hitrate--weak    { color: var(--color-warning); }
  .mem-hitrate--none    { color: var(--color-text-muted); }

  /* ── Sparkline ────────────────────────────────────────────────────────────── */
  .trend-row {
    grid-column: 1 / -1;
  }
  .trend-cycle-count {
    font-weight: 400;
    color: var(--color-text-faint);
    font-size: var(--text-xs);
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
    transition: opacity 0.15s;
  }
  .trend-bar:hover {
    opacity: 1 !important;
  }
  .trend-empty {
    font-size: var(--text-sm);
    color: var(--color-text-faint);
    line-height: 48px;
  }

  /* ── Memory card footer ───────────────────────────────────────────────────── */
  .memory-card-footer {
    margin-top: var(--space-4);
    padding-top: var(--space-3);
    border-top: 1px solid var(--color-border);
  }
  .mem-link {
    font-size: var(--text-xs);
    color: var(--color-brand, #4a9eff);
    text-decoration: none;
    opacity: 0.8;
    transition: opacity 0.15s;
  }
  .mem-link:hover {
    opacity: 1;
    text-decoration: underline;
  }

  /* ── Cycle Score Trajectory card ─────────────────────────────────────────── */
  .trajectory-card {
    margin-bottom: var(--space-4);
    padding: var(--space-5) var(--space-6);
  }
  .trajectory-header {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
    flex-wrap: wrap;
  }
  .trajectory-subtitle {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
  }

  /* Bar chart */
  .trajectory-chart {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    height: 80px;
    padding-bottom: var(--space-1);
    margin-bottom: var(--space-4);
    overflow-x: auto;
  }
  .trajectory-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-width: 36px;
    flex: 1 0 36px;
    max-width: 64px;
  }
  .trajectory-passrate-label {
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
  }
  .trajectory-bar-wrap {
    width: 100%;
    height: 48px;
    display: flex;
    align-items: flex-end;
  }
  .trajectory-bar {
    width: 100%;
    min-height: 4px;
    border-radius: 3px 3px 0 0;
    transition: opacity 0.15s;
  }
  .trajectory-bar--pr {
    /* Gold shimmer on bars where a PR was shipped */
    box-shadow: 0 0 4px rgba(245, 200, 66, 0.5);
  }
  .trajectory-bar:hover {
    opacity: 1 !important;
    filter: brightness(1.2);
  }
  .trajectory-ver {
    font-family: var(--font-mono);
    font-size: 8px;
    color: var(--color-text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    text-align: center;
  }

  /* Compact history table */
  .trajectory-table-wrap {
    overflow-x: auto;
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-3);
    margin-top: var(--space-1);
  }
  .trajectory-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-xs);
  }
  .trajectory-table th {
    text-align: left;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: var(--space-1) var(--space-2);
    border-bottom: 1px solid var(--color-border);
    white-space: nowrap;
  }
  .trajectory-table td {
    padding: var(--space-1) var(--space-2);
    border-bottom: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
    vertical-align: middle;
  }
  .cy-sprint {
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--color-text);
    white-space: nowrap;
  }
  .cy-stage {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .cy-mono {
    font-family: var(--font-mono);
    color: var(--color-text-muted);
    white-space: nowrap;
  }
  .cy-sub {
    opacity: 0.55;
    margin-left: 3px;
  }
</style>
