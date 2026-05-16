<script lang="ts">
  /**
   * /health — v2 design rebuild.
   *
   * Sections:
   *   1. Page header + overall status banner
   *   2. Service status cards: each with PulseDot + Ring + Sparkline
   *   3. Dependency matrix (Anthropic API, GitHub API, etc.)
   *   4. Recent incidents table
   *
   * Data:
   *   GET /api/v5/health          — server version, status
   *   GET /api/v5/health/services — per-service circuit-breaker stats
   */
  import { onMount, onDestroy } from 'svelte';
  import { Btn, Badge, Card, Ring, Sparkline, PulseDot } from '$lib/components/v2';
  import { withWorkspace } from '$lib/stores/workspace';

  // ── Types ────────────────────────────────────────────────────────────────────

  interface HealthData {
    status: 'ok' | 'error';
    version?: string;
    api?: string;
    workspaceId?: string;
    timestamp?: string;
  }

  interface ServiceHealth {
    service: string;
    totalCalls: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    circuitOpen: boolean;
    lastFailureAt?: string;
    lastSuccessAt?: string;
    circuitOpenedAt?: string;
    /** Latency percentiles — server may not always send these */
    p50?: number;
    p95?: number;
    p99?: number;
    /** Server may send a recent-latency sparkline */
    latencyHistory?: number[];
  }

  interface ServicesData {
    status: 'healthy' | 'degraded' | 'unhealthy';
    healthyCount: number;
    degradedCount: number;
    services: ServiceHealth[];
    timestamp: string;
  }

  // ── State ────────────────────────────────────────────────────────────────────

  let healthData: HealthData | null = $state(null);
  let servicesData: ServicesData | null = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);
  let lastRefreshedAt: Date | null = $state(null);

  let pollHandle: ReturnType<typeof setInterval> | null = null;

  // ── Data fetching ─────────────────────────────────────────────────────────────

  async function fetchAll(silent = false): Promise<void> {
    if (!silent) loading = true;
    error = null;
    try {
      const [hRes, sRes] = await Promise.all([
        fetch(withWorkspace('/api/v5/health')),
        fetch(withWorkspace('/api/v5/health/services')),
      ]);
      if (hRes.ok) healthData = await hRes.json() as HealthData;
      if (sRes.ok) servicesData = await sRes.json() as ServicesData;
      if (!hRes.ok && !sRes.ok) throw new Error(`HTTP ${hRes.status}`);
      lastRefreshedAt = new Date();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Connection failed';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void fetchAll();
    pollHandle = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void fetchAll(true);
    }, 10_000);
  });
  onDestroy(() => { if (pollHandle) clearInterval(pollHandle); });

  // ── Derived ──────────────────────────────────────────────────────────────────

  const overallStatus = $derived(
    servicesData?.status ?? (healthData?.status === 'ok' ? 'healthy' : 'unhealthy')
  );

  function statusColor(s: string): string {
    if (s === 'ok' || s === 'healthy') return 'var(--af-success)';
    if (s === 'degraded') return 'var(--af-warning)';
    return 'var(--af-danger)';
  }

  function rateColor(rate: number, circuitOpen: boolean): string {
    if (circuitOpen) return 'var(--af-danger)';
    if (rate >= 0.95) return 'var(--af-success)';
    if (rate >= 0.75) return 'var(--af-warning)';
    return 'var(--af-danger)';
  }

  function rateBadge(svc: ServiceHealth): 'success' | 'warning' | 'danger' {
    if (svc.circuitOpen) return 'danger';
    if (svc.successRate >= 0.95) return 'success';
    if (svc.successRate >= 0.75) return 'warning';
    return 'danger';
  }

  function fmtRel(ts: string | undefined): string {
    if (!ts) return '—';
    const d = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
    if (d < 60) return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }

  // Dependency check matrix — these are the external services AgentForge depends on.
  // Real status would require dedicated health checks; we derive from services list.
  const DEPENDENCIES = [
    { label: 'Anthropic API', key: 'anthropic' },
    { label: 'GitHub API', key: 'github' },
    { label: 'AgentForge API', key: 'api' },
    { label: 'Database', key: 'db' },
    { label: 'File System', key: 'fs' },
  ];

  const depStatuses = $derived(DEPENDENCIES.map(dep => {
    const svc = servicesData?.services.find(s =>
      s.service.toLowerCase().includes(dep.key) || dep.key.includes(s.service.toLowerCase())
    );
    return {
      ...dep,
      status: svc ? (svc.circuitOpen ? 'degraded' : svc.successRate >= 0.75 ? 'ok' : 'degraded') : 'unknown',
      successRate: svc?.successRate,
    };
  }));
</script>

<svelte:head><title>System Health — AgentForge</title></svelte:head>

<!-- ── Page header ────────────────────────────────────────────────────────────── -->
<header class="health-header">
  <div class="health-crumbs font-mono">Workspace · Health</div>
  <div class="health-headline-row">
    <div>
      <h1 class="health-title">System health</h1>
      <p class="health-subtitle">Real-time service health and circuit breaker status</p>
    </div>
    <div class="health-actions">
      <span class="font-mono health-meta">auto-refresh 10s</span>
      {#if lastRefreshedAt}
        <span class="font-mono health-ts">
          checked {lastRefreshedAt.toLocaleTimeString()}
        </span>
      {/if}
      <Btn size="sm" onclick={() => void fetchAll()}>Refresh</Btn>
    </div>
  </div>
</header>

{#if loading && !healthData && !servicesData}
  <!-- Skeleton -->
  <div class="skeleton" style="height:60px;border-radius:8px;margin-bottom:14px;"></div>
  <div class="services-grid">
    {#each Array(4) as _}
      <div class="skeleton" style="height:160px;border-radius:8px;"></div>
    {/each}
  </div>

{:else if error && !healthData && !servicesData}
  <div class="error-banner">
    Unable to reach API server: {error}
    <Btn size="sm" onclick={() => void fetchAll()} style="margin-left:12px">Retry</Btn>
  </div>

{:else}
  <!-- ── Overall status banner ───────────────────────────────────────────────────── -->
  <Card style="
    margin-bottom:14px;
    background:color-mix(in srgb,{statusColor(overallStatus)} 5%,transparent);
    border-color:color-mix(in srgb,{statusColor(overallStatus)} 25%,transparent);
  ">
    <div class="status-banner">
      <PulseDot color={statusColor(overallStatus)} size={9} ring={overallStatus === 'healthy'} />
      <div class="status-text">
        <span class="status-main" style="color:{statusColor(overallStatus)}">
          System {overallStatus.toUpperCase()}
        </span>
        {#if servicesData}
          &middot; {servicesData.healthyCount} healthy · {servicesData.degradedCount} degraded
        {/if}
        {#if error}
          <span class="status-warn"> · refresh failed</span>
        {/if}
      </div>
      {#if healthData?.version}
        <span class="font-mono version-badge">agentforge v{healthData.version}</span>
      {/if}
      {#if healthData?.workspaceId}
        <span class="font-mono ws-badge">ws:{healthData.workspaceId}</span>
      {/if}
    </div>
  </Card>

  <!-- ── Service cards grid ────────────────────────────────────────────────────── -->
  {#if servicesData && servicesData.services.length > 0}
    <div class="section-label">SERVICES ({servicesData.services.length})</div>
    <div class="services-grid" style="margin-bottom:14px;">
      {#each servicesData.services as svc (svc.service)}
        {@const color = rateColor(svc.successRate, svc.circuitOpen)}
        <Card hover style="
          border-color:color-mix(in srgb,{color} 30%,var(--af-border));
          background:color-mix(in srgb,{color} 3%,var(--af-surface));
        ">
          <div class="svc-header">
            <div class="svc-name-row">
              <PulseDot
                color={color}
                size={7}
                ring={!svc.circuitOpen && svc.successRate >= 0.95}
              />
              <span class="font-mono svc-name">{svc.service}</span>
            </div>
            <Badge variant={rateBadge(svc)}>
              {svc.circuitOpen ? 'Circuit Open' : 'Healthy'}
            </Badge>
          </div>

          <!-- Ring + stats row -->
          <div class="svc-body">
            <Ring
              value={Math.round(svc.successRate * 100)}
              max={100}
              size={56}
              stroke={4}
              color={color}
              label="{Math.round(svc.successRate * 100)}%"
            />
            <div class="svc-stats">
              <div class="svc-stat">
                <span class="font-mono svc-stat-label">calls</span>
                <span class="font-mono svc-stat-val">{svc.totalCalls.toLocaleString()}</span>
              </div>
              <div class="svc-stat">
                <span class="font-mono svc-stat-label">failures</span>
                <span class="font-mono svc-stat-val" style="color:{svc.failureCount > 0 ? 'var(--af-warning)' : 'var(--af-dim)'}">
                  {svc.failureCount}
                </span>
              </div>
              {#if svc.p99 != null}
                <div class="svc-stat">
                  <span class="font-mono svc-stat-label">p99</span>
                  <span class="font-mono svc-stat-val">{svc.p99}ms</span>
                </div>
              {/if}
            </div>
          </div>

          <!-- Latency sparkline (if available) -->
          {#if svc.latencyHistory && svc.latencyHistory.length > 2}
            <div style="margin-top:10px;">
              <Sparkline data={svc.latencyHistory} color={color} w={240} h={26} gradient />
            </div>
          {/if}

          <!-- Last check timestamps -->
          {#if svc.circuitOpenedAt}
            <div class="svc-alert font-mono">Circuit opened {fmtRel(svc.circuitOpenedAt)}</div>
          {:else if svc.lastSuccessAt}
            <div class="svc-ts font-mono">Last success {fmtRel(svc.lastSuccessAt)}</div>
          {/if}
        </Card>
      {/each}
    </div>
  {:else if !loading}
    <!-- API server health card when no services endpoint -->
    {#if healthData}
      <div class="section-label">API SERVER</div>
      <Card style="margin-bottom:14px;" hover>
        <div class="svc-header">
          <div class="svc-name-row">
            <PulseDot
              color={statusColor(healthData.status)}
              size={7}
              ring={healthData.status === 'ok'}
            />
            <span class="font-mono svc-name">REST API</span>
          </div>
          <Badge variant={healthData.status === 'ok' ? 'success' : 'danger'}>
            {healthData.status === 'ok' ? 'Online' : 'Error'}
          </Badge>
        </div>
        {#if healthData.version}
          <div class="svc-ts font-mono">Version {healthData.version}</div>
        {/if}
      </Card>
    {/if}
  {/if}

  <!-- ── Dependency matrix ──────────────────────────────────────────────────────── -->
  <div class="section-label">DEPENDENCY MATRIX</div>
  <Card noPad style="margin-bottom:14px;">
    <table class="dep-table">
      <thead>
        <tr>
          <th>Dependency</th>
          <th>Status</th>
          <th>Success rate</th>
          <th>Last check</th>
        </tr>
      </thead>
      <tbody>
        {#each depStatuses as dep}
          {@const color = dep.status === 'ok' ? 'var(--af-success)' : dep.status === 'degraded' ? 'var(--af-warning)' : 'var(--af-dim)'}
          <tr>
            <td class="font-mono">{dep.label}</td>
            <td>
              <div class="dep-status">
                <span class="dep-dot" style="background:{color}"></span>
                <span class="font-mono dep-status-text" style="color:{color}">
                  {dep.status}
                </span>
              </div>
            </td>
            <td class="font-mono">
              {dep.successRate != null ? Math.round(dep.successRate * 100) + '%' : '—'}
            </td>
            <td class="font-mono dim">
              {lastRefreshedAt ? lastRefreshedAt.toLocaleTimeString() : '—'}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </Card>

  <!-- ── Recent incidents ───────────────────────────────────────────────────────── -->
  <div class="section-label">RECENT INCIDENTS</div>
  <Card noPad>
    {#if servicesData?.services.some(s => s.circuitOpen || s.failureCount > 0)}
      <table class="inc-table">
        <thead>
          <tr>
            <th>Service</th>
            <th>Type</th>
            <th>Started</th>
            <th>Failures</th>
          </tr>
        </thead>
        <tbody>
          {#each servicesData?.services.filter(s => s.failureCount > 0) ?? [] as svc}
            <tr>
              <td class="font-mono">{svc.service}</td>
              <td>
                <Badge variant={svc.circuitOpen ? 'danger' : 'warning'}>
                  {svc.circuitOpen ? 'Circuit Open' : 'Degraded'}
                </Badge>
              </td>
              <td class="font-mono">{fmtRel(svc.circuitOpenedAt ?? svc.lastFailureAt)}</td>
              <td class="font-mono">{svc.failureCount}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <div class="incidents-empty">
        <span class="incidents-check" style="color:var(--af-success)">✓</span>
        <div class="incidents-title">No incidents in the last 30 days.</div>
        <div class="font-mono incidents-sub">All systems healthy.</div>
      </div>
    {/if}
  </Card>
{/if}

<style>
  /* ── Page header ─────────────────────────────────────────────────────────────── */
  .health-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
  }
  .health-crumbs {
    font-size: 11px;
    color: var(--af-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .health-headline-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .health-title {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--af-text);
  }
  .health-subtitle {
    font-size: 12px;
    color: var(--af-muted);
    margin: 2px 0 0;
  }
  .health-actions { display: flex; align-items: center; gap: 8px; }
  .health-meta { font-size: 11px; color: var(--af-dim); }
  .health-ts { font-size: 11px; color: var(--af-faint); }

  /* ── Status banner ───────────────────────────────────────────────────────────── */
  .status-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .status-text {
    font-size: 14px;
    font-weight: 600;
    flex: 1;
  }
  .status-main { font-weight: 700; }
  .status-warn { color: var(--af-warning); }
  .version-badge, .ws-badge {
    font-size: 11px;
    color: var(--af-dim);
    background: var(--af-surface);
    border: 1px solid var(--af-border);
    padding: 2px 8px;
    border-radius: 99px;
  }

  /* ── Section label ───────────────────────────────────────────────────────────── */
  .section-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    text-transform: uppercase;
    margin-bottom: 8px;
  }

  /* ── Services grid ───────────────────────────────────────────────────────────── */
  .services-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 10px;
  }

  /* ── Service card ────────────────────────────────────────────────────────────── */
  .svc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .svc-name-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .svc-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--af-text);
  }
  .svc-body {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 10px;
  }
  .svc-stats {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
  }
  .svc-stat {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .svc-stat-label { font-size: 11px; color: var(--af-dim); }
  .svc-stat-val { font-size: 11px; color: var(--af-text); }
  .svc-alert { font-size: 11px; color: var(--af-danger); margin-top: 6px; }
  .svc-ts { font-size: 10px; color: var(--af-faint); margin-top: 6px; }

  /* ── Dependency matrix ───────────────────────────────────────────────────────── */
  .dep-table, .inc-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .dep-table th, .inc-table th {
    text-align: left;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--af-dim);
    padding: 8px 14px;
    border-bottom: 1px solid var(--af-border);
  }
  .dep-table td, .inc-table td {
    padding: 8px 14px;
    border-bottom: 1px solid color-mix(in srgb, var(--af-border) 60%, transparent);
    color: var(--af-text);
    vertical-align: middle;
  }
  .dep-table tbody tr:last-child td,
  .inc-table tbody tr:last-child td { border-bottom: none; }
  .dep-table tbody tr:hover,
  .inc-table tbody tr:hover { background: var(--af-surface2); }

  .dep-status { display: flex; align-items: center; gap: 6px; }
  .dep-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .dep-status-text { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .dim { color: var(--af-dim); }

  /* ── Incidents ───────────────────────────────────────────────────────────────── */
  .incidents-empty {
    padding: 28px;
    text-align: center;
  }
  .incidents-check { font-size: 28px; }
  .incidents-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--af-text);
    margin-top: 8px;
  }
  .incidents-sub {
    font-size: 11px;
    color: var(--af-dim);
    margin-top: 4px;
  }

  /* ── Error + skeleton ────────────────────────────────────────────────────────── */
  .error-banner {
    display: flex;
    align-items: center;
    padding: 14px 16px;
    background: color-mix(in srgb, var(--af-danger) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-danger) 30%, transparent);
    border-radius: 8px;
    color: var(--af-danger);
    font-size: 13px;
    margin-bottom: 14px;
  }
  .skeleton {
    background: linear-gradient(90deg, var(--af-surface) 0%, var(--af-surface2) 50%, var(--af-surface) 100%);
    background-size: 200% 100%;
    animation: skel 1.4s ease-in-out infinite;
    margin-bottom: 10px;
  }
  @keyframes skel {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
</style>
