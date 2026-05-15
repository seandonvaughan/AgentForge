<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  const API_BASE = '';

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
  }

  interface HealthData {
    status: 'ok' | 'error';
    version?: string;
    api?: string;
    workspaceId?: string;
    timestamp?: string;
  }

  interface ServicesData {
    status: 'healthy' | 'degraded' | 'unhealthy';
    healthyCount: number;
    degradedCount: number;
    services: ServiceHealth[];
    timestamp: string;
  }

  let healthData: HealthData | null = null;
  let servicesData: ServicesData | null = null;
  let loading = true;
  let error: string | null = null;
  let lastRefreshed = '';
  let interval: ReturnType<typeof setInterval> | null = null;

  async function fetchAll() {
    loading = true;
    error = null;
    try {
      const [hRes, sRes] = await Promise.all([
        fetch(`${API_BASE}/api/v5/health`),
        fetch(`${API_BASE}/api/v5/health/services`),
      ]);
      if (hRes.ok) healthData = await hRes.json();
      if (sRes.ok) servicesData = await sRes.json();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Connection failed';
    } finally {
      loading = false;
      lastRefreshed = new Date().toLocaleTimeString();
    }
  }

  onMount(() => {
    fetchAll();
    interval = setInterval(fetchAll, 10_000);
  });

  onDestroy(() => {
    if (interval !== null) clearInterval(interval);
  });

  function statusColor(status: string): string {
    if (status === 'ok' || status === 'healthy') return 'var(--color-success, rgb(34,197,94))';
    if (status === 'degraded') return 'rgb(234,179,8)';
    return 'rgb(239,68,68)';
  }

  function successRatePct(rate: number): string {
    return `${Math.round(rate * 100)}%`;
  }

  function successRateColor(rate: number, circuitOpen: boolean): string {
    if (circuitOpen) return 'rgb(239,68,68)';
    if (rate >= 0.95) return 'var(--color-success, rgb(34,197,94))';
    if (rate >= 0.75) return 'rgb(234,179,8)';
    return 'rgb(239,68,68)';
  }
</script>

<svelte:head><title>System Health — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">System Health</h1>
    <p class="page-subtitle">Real-time service health and circuit breaker status</p>
  </div>
  <div class="header-actions">
    {#if lastRefreshed}
      <span class="refresh-time">Last refreshed {lastRefreshed}</span>
    {/if}
    <button class="btn-refresh" onclick={fetchAll} disabled={loading}>
      {loading ? 'Refreshing…' : 'Refresh'}
    </button>
  </div>
</div>

{#if error}
  <div class="error-banner">
    Unable to reach API server: {error}
  </div>
{:else}
  <!-- Overall status banner -->
  <div class="status-banner" style="border-color: {statusColor(servicesData?.status ?? 'ok')}; background: {statusColor(servicesData?.status ?? 'ok')}12;">
    <span class="status-dot" style="background: {statusColor(servicesData?.status ?? 'ok')};"></span>
    <span class="status-text">
      {#if loading}
        Checking system health…
      {:else if servicesData}
        System {servicesData.status.toUpperCase()} —
        {servicesData.healthyCount} healthy,
        {servicesData.degradedCount} degraded
      {:else}
        API unreachable
      {/if}
    </span>
    {#if healthData?.version}
      <span class="version-badge">agentforge v{healthData.version}</span>
    {/if}
  </div>

  <!-- API health card -->
  {#if healthData}
    <div class="section-title">API Server</div>
    <div class="health-card {healthData.status === 'ok' ? 'card-healthy' : 'card-degraded'}">
      <div class="card-header">
        <span class="svc-name">REST API</span>
        <span class="circuit-badge {healthData.status === 'ok' ? 'badge-healthy' : 'badge-open'}">
          {healthData.status === 'ok' ? 'Online' : 'Error'}
        </span>
      </div>
      {#if healthData.version}
        <div class="card-meta">Version: {healthData.version} | Workspace: {healthData.workspaceId ?? 'default'}</div>
      {/if}
    </div>
  {/if}

  <!-- Service health cards -->
  {#if servicesData}
    <div class="section-title" style="margin-top: var(--space-5);">Services ({servicesData.services.length})</div>
    <div class="services-grid">
      {#each servicesData.services as svc}
        <div class="health-card {svc.circuitOpen ? 'card-degraded' : 'card-healthy'}">
          <div class="card-header">
            <span class="svc-name">{svc.service}</span>
            <span class="circuit-badge {svc.circuitOpen ? 'badge-open' : 'badge-healthy'}">
              {svc.circuitOpen ? 'Circuit Open' : 'Healthy'}
            </span>
          </div>

          <!-- Success rate bar -->
          <div class="rate-bar-label">
            <span>Success Rate</span>
            <span style="color: {successRateColor(svc.successRate, svc.circuitOpen)};">
              {successRatePct(svc.successRate)}
            </span>
          </div>
          <div class="rate-bar-track">
            <div
              class="rate-bar-fill"
              style="width: {successRatePct(svc.successRate)}; background: {successRateColor(svc.successRate, svc.circuitOpen)};"
            ></div>
          </div>

          <div class="card-meta-row">
            <span>Total calls: {svc.totalCalls}</span>
            <span>Failures: {svc.failureCount}</span>
          </div>

          {#if svc.circuitOpenedAt}
            <div class="card-alert">Circuit opened at {new Date(svc.circuitOpenedAt).toLocaleTimeString()}</div>
          {/if}
          {#if svc.lastFailureAt && !svc.circuitOpenedAt}
            <div class="card-meta">Last failure: {new Date(svc.lastFailureAt).toLocaleTimeString()}</div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: var(--space-5);
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .page-title {
    font-size: var(--text-2xl, 1.5rem);
    font-weight: 700;
    color: var(--color-text);
    margin: 0 0 var(--space-1);
  }

  .page-subtitle {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    margin: 0;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .refresh-time {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }

  .btn-refresh {
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 4px);
    color: var(--color-text);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-refresh:hover:not(:disabled) {
    background: var(--color-surface-hover, rgba(255,255,255,0.06));
  }

  .btn-refresh:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error-banner {
    padding: var(--space-4);
    background: rgba(239,68,68,0.08);
    border: 1px solid rgba(239,68,68,0.3);
    border-radius: var(--radius-md);
    color: rgb(239,68,68);
    font-size: var(--text-sm);
    margin-bottom: var(--space-4);
  }

  .status-banner {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border: 1px solid;
    border-radius: var(--radius-md);
    margin-bottom: var(--space-5);
  }

  .status-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-text {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text);
    flex: 1;
  }

  .version-badge {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    padding: 2px 8px;
    border-radius: 999px;
    font-family: var(--font-mono, monospace);
  }

  .section-title {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: var(--space-3);
  }

  .services-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--space-3);
  }

  .health-card {
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .health-card.card-healthy {
    border-color: rgba(34,197,94,0.25);
  }

  .health-card.card-degraded {
    border-color: rgba(239,68,68,0.35);
    background: rgba(239,68,68,0.03);
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-3);
  }

  .svc-name {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text);
    font-family: var(--font-mono, monospace);
  }

  .circuit-badge {
    font-size: var(--text-xs);
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 999px;
  }

  .badge-healthy {
    background: rgba(34,197,94,0.12);
    color: rgb(34,197,94);
  }

  .badge-open {
    background: rgba(239,68,68,0.12);
    color: rgb(239,68,68);
  }

  .rate-bar-label {
    display: flex;
    justify-content: space-between;
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin-bottom: var(--space-1);
  }

  .rate-bar-track {
    width: 100%;
    height: 6px;
    background: var(--color-border);
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: var(--space-3);
  }

  .rate-bar-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .card-meta-row {
    display: flex;
    gap: var(--space-4);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }

  .card-meta {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin-top: var(--space-2);
  }

  .card-alert {
    font-size: var(--text-xs);
    color: rgb(239,68,68);
    margin-top: var(--space-2);
  }
</style>
