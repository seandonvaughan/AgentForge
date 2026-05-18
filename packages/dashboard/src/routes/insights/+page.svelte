<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import type { PageData } from './$types';
  import { Card, Badge, KpiTile, Sparkline, Btn } from '$lib/components/v2';

  let { data }: { data: PageData } = $props();

  type InsightKind = 'win' | 'risk' | 'shift';

  interface Insight {
    kind: InsightKind;
    title: string;
    body: string;
    metric?: string;
  }

  interface InsightsResponse {
    insights: Insight[];
    derivedFrom: number;
    timestamp: string;
  }

  let insights: Insight[] = $state((data.insights ?? []) as Insight[]);
  let derivedFrom: number = $state((data.derivedFrom ?? 0) as number);
  let timestamp: string = $state((data.timestamp ?? '') as string);
  let loading = $state(insights.length === 0);
  let error: string | null = $state(null);
  let interval: ReturnType<typeof setInterval> | null = null;

  async function loadInsights() {
    if (browser && document.visibilityState === 'hidden') return;
    try {
      const res = await fetch('/api/v5/insights');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as InsightsResponse;
      insights = body.insights as Insight[];
      derivedFrom = body.derivedFrom;
      timestamp = body.timestamp;
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load insights';
    } finally {
      loading = false;
    }
  }

  function variantForKind(kind: InsightKind): 'success' | 'warning' | 'info' {
    if (kind === 'win') return 'success';
    if (kind === 'risk') return 'warning';
    return 'info';
  }

  function labelForKind(kind: InsightKind): string {
    if (kind === 'win') return 'WIN';
    if (kind === 'risk') return 'WATCH';
    return 'SHIFT';
  }

  function borderColorForKind(kind: InsightKind): string {
    if (kind === 'win') return 'var(--af-success)';
    if (kind === 'risk') return 'var(--af-warning)';
    return 'var(--af-sonnet)';
  }

  function sparkColorForKind(kind: InsightKind): string {
    if (kind === 'win') return 'var(--af-success)';
    if (kind === 'risk') return 'var(--af-warning)';
    return 'var(--af-sonnet)';
  }

  const winCount = $derived(insights.filter(i => i.kind === 'win').length);
  const riskCount = $derived(insights.filter(i => i.kind === 'risk').length);
  const shiftCount = $derived(insights.filter(i => i.kind === 'shift').length);

  function fmtTime(iso: string): string {
    try { return new Date(iso).toLocaleTimeString(); } catch { return ''; }
  }

  onMount(() => {
    if (insights.length === 0) loadInsights();
    interval = setInterval(loadInsights, 30_000);
    if (browser) document.addEventListener('visibilitychange', loadInsights);
  });

  onDestroy(() => {
    if (interval) clearInterval(interval);
    if (browser) document.removeEventListener('visibilitychange', loadInsights);
  });
</script>

<div class="page">
  <div class="page-header">
    <div>
      <div class="crumbs">Workspace / Insights</div>
      <h1 class="page-title">Insights</h1>
      <p class="page-sub">Auto-generated observations from your cycle data</p>
    </div>
    <div class="header-actions">
      <Btn size="sm" onClick={loadInsights}>↺ Refresh</Btn>
    </div>
  </div>

  <div class="kpi-row">
    <KpiTile label="Wins" value={winCount} color="var(--af-success)" />
    <KpiTile label="Risks" value={riskCount} color="var(--af-warning)" />
    <KpiTile label="Shifts" value={shiftCount} color="var(--af-sonnet)" />
    <KpiTile label="Cycles Analysed" value={derivedFrom} color="var(--af-muted)" />
  </div>

  {#if loading}
    <Card>
      <div class="state-center">
        <div class="spinner"></div>
        <span style="font-size:12px;color:var(--af-dim);margin-top:8px">Loading insights...</span>
      </div>
    </Card>
  {:else if error}
    <Card>
      <div class="state-center">
        <span style="font-size:22px;color:var(--af-danger)">⚠</span>
        <span style="font-size:12px;color:var(--af-danger);margin-top:6px">{error}</span>
        <div style="margin-top:10px"><Btn size="sm" variant="ghost" onClick={loadInsights}>Retry</Btn></div>
      </div>
    </Card>
  {:else if insights.length === 0}
    <Card>
      <div class="state-center">
        <span style="font-size:28px;color:var(--af-faint)">◎</span>
        <div style="font-size:13px;color:var(--af-text);font-weight:600;margin-top:8px">No insights yet.</div>
        <div style="font-size:11px;color:var(--af-dim);margin-top:4px">Run a few cycles to generate observations.</div>
      </div>
    </Card>
  {:else}
    <div class="insights-grid">
      {#each insights as insight (insight.title)}
        <Card hover style="border-left:3px solid {borderColorForKind(insight.kind)};padding:18px;">
          <div class="insight-header">
            <Badge variant={variantForKind(insight.kind)}>{labelForKind(insight.kind)}</Badge>
            {#if insight.metric}
              <span class="insight-metric font-mono">{insight.metric}</span>
            {/if}
            <span class="flex1"></span>
            <Sparkline data={[3,5,4,7,6,8,5,9,7,10]} color={sparkColorForKind(insight.kind)} w={120} h={28} gradient />
          </div>
          <div class="insight-title">{insight.title}</div>
          <div class="insight-body">{insight.body}</div>
          <div class="insight-actions">
            <Btn size="sm">Dig in</Btn>
            <Btn size="sm">Dismiss</Btn>
          </div>
        </Card>
      {/each}
    </div>
    {#if timestamp}
      <div class="footer-ts font-mono">Updated at {fmtTime(timestamp)} · derived from {derivedFrom} cycles</div>
    {/if}
  {/if}
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 14px; padding: 20px 24px; max-width: 1200px; }
  .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 2px; }
  .crumbs { font-size: 10px; color: var(--af-faint); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 4px; }
  .page-title { margin: 0; font-size: 20px; font-weight: 700; color: var(--af-text); }
  .page-sub { margin: 4px 0 0; font-size: 12px; color: var(--af-dim); }
  .header-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; padding-top: 4px; }
  .kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .insights-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .insight-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .insight-metric { font-size: 12px; color: var(--af-muted); padding: 1px 6px; background: var(--af-surface2); border: 1px solid var(--af-border2); border-radius: 4px; }
  .flex1 { flex: 1; }
  .insight-title { font-size: 15px; font-weight: 600; color: var(--af-text); letter-spacing: -0.01em; margin-bottom: 6px; }
  .insight-body { font-size: 12px; color: var(--af-dim); line-height: 1.55; }
  .insight-actions { display: flex; gap: 8px; margin-top: 12px; }
  .state-center { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; text-align: center; }
  .spinner { width: 24px; height: 24px; border: 2px solid var(--af-border2); border-top-color: var(--af-purple); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .footer-ts { font-size: 10px; color: var(--af-faint); text-align: right; padding: 0 4px; }
  .font-mono { font-family: var(--af-font-mono); font-feature-settings: 'tnum' 1; }
  @media (max-width: 800px) { .kpi-row { grid-template-columns: repeat(2, 1fr); } .insights-grid { grid-template-columns: 1fr; } }
</style>
