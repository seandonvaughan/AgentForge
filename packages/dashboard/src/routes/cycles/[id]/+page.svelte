<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import StageBadge from '$lib/components/StageBadge.svelte';
  import { relativeTime, formatDuration } from '$lib/util/relative-time';
  import { withWorkspace } from '$lib/stores/workspace';

  const TERMINAL = new Set(['completed', 'failed', 'killed']);
  const PHASES = ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn'] as const;
  const FILES = ['tests', 'git', 'pr', 'approval-pending', 'approval-decision'] as const;
  type Phase = (typeof PHASES)[number];
  type FileName = (typeof FILES)[number];
  type Tab = 'overview' | 'scoring' | 'events' | 'phases' | 'files';

  let id = $derived($page.params.id);

  let cycle: any = $state(null);
  let scoring: any = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);

  let activeTab: Tab = $state('overview');

  // Events
  let events: any[] = $state([]);
  let eventsSince = 0;
  let eventSource: EventSource | null = null;
  let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let sseConnected = $state(false);

  // Phases (lazy)
  let openPhases: Record<string, boolean> = $state({});
  let phaseData: Record<string, any> = $state({});
  let phaseLoading: Record<string, boolean> = $state({});
  let phaseError: Record<string, string | null> = $state({});

  // Files
  let activeFile: FileName = $state('tests');
  let fileData: Record<string, any> = $state({});
  let fileLoading: Record<string, boolean> = $state({});
  let fileError: Record<string, string | null> = $state({});

  let stage = $derived(cycle?.stage ?? cycle?.result?.stage ?? cycle?.currentStage ?? 'unknown');
  let isTerminal = $derived(TERMINAL.has(String(stage).toLowerCase()));

  async function loadInitial() {
    loading = true;
    error = null;
    try {
      const [cRes, sRes] = await Promise.all([
        fetch(withWorkspace(`/api/v5/cycles/${id}`)),
        fetch(withWorkspace(`/api/v5/cycles/${id}/scoring`)),
      ]);
      if (!cRes.ok) throw new Error(`cycle: HTTP ${cRes.status}`);
      cycle = await cRes.json();
      if (sRes.ok) {
        scoring = await sRes.json();
      } else if (sRes.status !== 404) {
        // non-fatal
        scoring = null;
      }
      ensureSseSubscription();
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  async function loadEvents() {
    // Historical bootstrap — fetched once on mount and on manual refresh.
    try {
      const res = await fetch(withWorkspace(`/api/v5/cycles/${id}/events?since=${eventsSince}`));
      if (!res.ok) return;
      const json = await res.json();
      const list = Array.isArray(json) ? json : (json.events ?? []);
      if (list.length > 0) {
        // Newest first
        events = [...list.slice().reverse(), ...events];
        eventsSince += list.length;
      }
    } catch {
      // ignore
    }
  }

  function ensureSseSubscription() {
    if (eventSource || isTerminal) return;
    try {
      const es = new EventSource('/api/v5/stream');
      eventSource = es;
      es.onopen = () => { sseConnected = true; };
      es.onmessage = (e) => {
        try {
          const parsed = JSON.parse(e.data);
          if (parsed?.type !== 'cycle_event') return;
          const data = parsed.data ?? {};
          if (data.cycleId !== id) return;
          // Prepend (most recent first)
          events = [data.payload ?? data, ...events];
          eventsSince += 1;
        } catch { /* ignore */ }
      };
      es.onerror = () => {
        sseConnected = false;
        es.close();
        eventSource = null;
        if (!isTerminal) {
          sseReconnectTimer = setTimeout(() => ensureSseSubscription(), 3000);
        }
      };
    } catch {
      // EventSource unavailable — fall back silently.
    }
  }

  function teardownSse() {
    if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer = null; }
    if (eventSource) { eventSource.close(); eventSource = null; }
    sseConnected = false;
  }

  function setTab(t: Tab) {
    activeTab = t;
    if (t === 'events' && events.length === 0) {
      loadEvents();
    }
  }

  async function togglePhase(phase: Phase) {
    openPhases[phase] = !openPhases[phase];
    if (openPhases[phase] && phaseData[phase] === undefined) {
      phaseLoading[phase] = true;
      phaseError[phase] = null;
      try {
        const res = await fetch(withWorkspace(`/api/v5/cycles/${id}/phases/${phase}`));
        if (res.status === 404) {
          phaseData[phase] = null;
        } else if (!res.ok) {
          phaseError[phase] = `HTTP ${res.status}`;
        } else {
          phaseData[phase] = await res.json();
        }
      } catch (e) {
        phaseError[phase] = String(e);
      } finally {
        phaseLoading[phase] = false;
      }
    }
  }

  async function loadFile(name: FileName) {
    activeFile = name;
    if (fileData[name] !== undefined) return;
    fileLoading[name] = true;
    fileError[name] = null;
    try {
      const res = await fetch(withWorkspace(`/api/v5/cycles/${id}/files/${name}`));
      if (res.status === 404) {
        fileData[name] = null;
      } else if (!res.ok) {
        fileError[name] = `HTTP ${res.status}`;
      } else {
        fileData[name] = await res.json();
      }
    } catch (e) {
      fileError[name] = String(e);
    } finally {
      fileLoading[name] = false;
    }
  }

  function pretty(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function costFraction(cost?: number | null, budget?: number | null): number {
    if (cost == null || budget == null || budget <= 0) return 0;
    return Math.min(1, cost / budget);
  }

  $effect(() => {
    // Close SSE once cycle reaches terminal stage
    void stage;
    if (isTerminal) teardownSse();
  });

  onMount(() => {
    loadInitial();
    // Eager-load default file tab
    loadFile('tests');
  });

  onDestroy(() => {
    teardownSse();
  });

  // Overview helpers
  let costUsd = $derived(cycle?.cost?.totalUsd ?? cycle?.costUsd ?? cycle?.cost?.usd ?? cycle?.budget?.spentUsd ?? null);
  let budgetUsd = $derived(cycle?.cost?.budgetUsd ?? cycle?.budgetUsd ?? cycle?.budget?.limitUsd ?? cycle?.budget?.budgetUsd ?? null);
  let testsPassed = $derived(cycle?.testsPassed ?? cycle?.tests?.passed ?? null);
  let testsTotal = $derived(cycle?.testsTotal ?? cycle?.tests?.total ?? null);
  let prUrl = $derived(cycle?.prUrl ?? cycle?.pr?.url ?? null);
  let branch = $derived(cycle?.branch ?? cycle?.git?.branch ?? null);
  let commitSha = $derived(cycle?.commitSha ?? cycle?.git?.commitSha ?? cycle?.git?.sha ?? null);
  let durationMs = $derived(cycle?.durationMs ?? null);
  let killSwitch = $derived(cycle?.killSwitch ?? cycle?.kill ?? null);
  let scoringResult = $derived(scoring?.result ?? scoring ?? null);
</script>

<svelte:head><title>Cycle {id?.slice(0, 8) ?? ''} — AgentForge v6</title></svelte:head>

<div class="page-header">
  <div>
    <nav class="breadcrumb">
      <a href="/cycles">← Cycles</a>
    </nav>
    <h1 class="page-title">
      Cycle <span class="mono">{id?.slice(0, 8)}</span>
      {#if cycle}<StageBadge stage={stage} />{/if}
    </h1>
    <p class="page-subtitle">
      {#if cycle?.sprintVersion}{cycle.sprintVersion} · {/if}
      {#if cycle?.startedAt}started {relativeTime(cycle.startedAt)}{/if}
    </p>
  </div>
</div>

{#if loading}
  <div class="card">
    <div class="skeleton" style="height:32px;margin-bottom:12px;"></div>
    <div class="skeleton" style="height:32px;margin-bottom:12px;"></div>
    <div class="skeleton" style="height:32px;"></div>
  </div>
{:else if error}
  <div class="error-banner">
    <div>Failed to load cycle: <code>{error}</code></div>
    <button class="btn btn-ghost btn-sm" onclick={loadInitial}>Retry</button>
  </div>
{:else if cycle}
  <nav class="tabs">
    <button class="tab" class:active={activeTab === 'overview'} onclick={() => setTab('overview')}>Overview</button>
    <button class="tab" class:active={activeTab === 'scoring'} onclick={() => setTab('scoring')}>Scoring</button>
    <button class="tab" class:active={activeTab === 'events'} onclick={() => setTab('events')}>Events</button>
    <button class="tab" class:active={activeTab === 'phases'} onclick={() => setTab('phases')}>Phases</button>
    <button class="tab" class:active={activeTab === 'files'} onclick={() => setTab('files')}>Files</button>
  </nav>

  <section class="tab-panel">
    {#if activeTab === 'overview'}
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">Stage</div>
          <div class="stat-value" style="font-size: var(--text-lg);"><StageBadge stage={stage} /></div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Duration</div>
          <div class="stat-value">{formatDuration(durationMs)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Cost</div>
          <div class="stat-value">
            {costUsd != null ? `$${Number(costUsd).toFixed(2)}` : '—'}
          </div>
          {#if budgetUsd != null && costUsd != null}
            <div class="cost-bar" style="margin-top:var(--space-2);">
              <div class="cost-bar-fill" style="width:{costFraction(costUsd, budgetUsd) * 100}%"></div>
            </div>
            <div class="muted" style="margin-top:var(--space-1);">of ${Number(budgetUsd).toFixed(2)}</div>
          {/if}
        </div>
        <div class="stat-card">
          <div class="stat-label">Tests</div>
          <div class="stat-value">
            {testsTotal != null ? `${testsPassed ?? 0}/${testsTotal}` : '—'}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><span class="card-title">Git</span></div>
        <dl class="kv">
          <dt>Branch</dt><dd class="mono">{branch ?? '—'}</dd>
          <dt>Commit</dt><dd class="mono">{commitSha ? String(commitSha).slice(0, 12) : '—'}</dd>
          <dt>PR</dt>
          <dd>
            {#if prUrl}
              <a href={prUrl} target="_blank" rel="noopener" class="pr-link">{prUrl} ↗</a>
            {:else}—{/if}
          </dd>
        </dl>
      </div>

      {#if killSwitch}
        <div class="card kill-card">
          <div class="card-header"><span class="card-title">Kill Switch Tripped</span></div>
          <pre class="json">{pretty(killSwitch)}</pre>
        </div>
      {/if}
    {/if}

    {#if activeTab === 'scoring'}
      {#if !scoringResult}
        <div class="card"><div class="empty-state">No scoring data available for this cycle.</div></div>
      {:else}
        {#if scoringResult.summary}
          <div class="card">
            <div class="card-header"><span class="card-title">Summary</span></div>
            <p class="summary">{scoringResult.summary}</p>
          </div>
        {/if}
        {#if scoringResult.warnings && scoringResult.warnings.length > 0}
          <div class="warning-banner">
            <strong>Warnings:</strong>
            <ul>
              {#each scoringResult.warnings as w}<li>{w}</li>{/each}
            </ul>
          </div>
        {/if}
        <div class="ranked-list">
          {#each (scoringResult.items ?? scoringResult.ranked ?? []) as item, i (item.id ?? i)}
            <article class="rank-card">
              <div class="rank-header">
                <span class="rank-num">#{item.rank ?? i + 1}</span>
                <h3 class="rank-title">{item.title ?? item.id ?? 'Untitled'}</h3>
                <div class="rank-stats">
                  <span class="badge muted">score {item.score ?? '—'}</span>
                  <span class="badge muted">conf {item.confidence ?? '—'}</span>
                  <span class="badge muted">${item.cost ?? item.estimatedCost ?? '—'}</span>
                  {#if item.withinBudget != null}
                    <span class="badge {item.withinBudget ? 'success' : 'danger'}">
                      {item.withinBudget ? 'within budget' : 'over budget'}
                    </span>
                  {/if}
                </div>
              </div>
              {#if item.rationale}<p class="rank-rationale">{item.rationale}</p>{/if}
              {#if item.dependencies && item.dependencies.length > 0}
                <div class="rank-meta">
                  <strong>deps:</strong> {item.dependencies.join(', ')}
                </div>
              {/if}
              {#if item.suggestedAssignee}
                <div class="rank-meta"><strong>assignee:</strong> <span class="mono">{item.suggestedAssignee}</span></div>
              {/if}
              {#if item.suggestedTags && item.suggestedTags.length > 0}
                <div class="rank-meta">
                  {#each item.suggestedTags as tag}<span class="tag">{tag}</span>{/each}
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    {/if}

    {#if activeTab === 'events'}
      <div class="events-toolbar">
        <span class="muted">{events.length} events {!isTerminal ? (sseConnected ? '· live (SSE)' : '· connecting…') : ''}</span>
        <button class="btn btn-ghost btn-sm" onclick={loadEvents}>Refresh</button>
      </div>
      {#if events.length === 0}
        <div class="card"><div class="empty-state">No events yet.</div></div>
      {:else}
        <div class="timeline">
          {#each events as ev, i (i)}
            <div class="event-row">
              <span class="event-ts mono">{relativeTime(ev.at ?? ev.timestamp)}</span>
              <span class="badge muted">{ev.type ?? 'event'}</span>
              <pre class="event-payload">{pretty(ev)}</pre>
            </div>
          {/each}
        </div>
      {/if}
    {/if}

    {#if activeTab === 'phases'}
      <div class="phase-list">
        {#each PHASES as phase}
          <div class="phase-item">
            <button class="phase-toggle" onclick={() => togglePhase(phase)}>
              <span class="phase-arrow">{openPhases[phase] ? '▼' : '▶'}</span>
              <span class="phase-name">{phase}</span>
            </button>
            {#if openPhases[phase]}
              <div class="phase-body">
                {#if phaseLoading[phase]}
                  <div class="skeleton" style="height:60px;"></div>
                {:else if phaseError[phase]}
                  <div class="error-msg">{phaseError[phase]}</div>
                {:else if phaseData[phase] == null}
                  <div class="muted">Not present.</div>
                {:else}
                  {#if phaseData[phase].agentRuns}
                    <div class="phase-runs">
                      <strong>agentRuns:</strong> {phaseData[phase].agentRuns.length ?? 0}
                    </div>
                  {/if}
                  <pre class="json">{pretty(phaseData[phase])}</pre>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if activeTab === 'files'}
      <nav class="file-tabs">
        {#each FILES as f}
          <button class="file-tab" class:active={activeFile === f} onclick={() => loadFile(f)}>{f}.json</button>
        {/each}
      </nav>
      <div class="card" style="margin-top:var(--space-3);">
        {#if fileLoading[activeFile]}
          <div class="skeleton" style="height:120px;"></div>
        {:else if fileError[activeFile]}
          <div class="error-msg">{fileError[activeFile]}</div>
        {:else if fileData[activeFile] == null}
          <div class="muted">not present</div>
        {:else}
          <pre class="json">{pretty(fileData[activeFile])}</pre>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .breadcrumb { margin-bottom: var(--space-2); }
  .breadcrumb a {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-decoration: none;
  }
  .breadcrumb a:hover { color: var(--color-text); }
  .page-title {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .tabs {
    display: flex;
    gap: var(--space-1);
    border-bottom: 1px solid var(--color-border);
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }
  .tab {
    background: transparent;
    border: none;
    color: var(--color-text-muted);
    padding: var(--space-3) var(--space-4);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: color var(--duration-fast), border-color var(--duration-fast);
    font-family: var(--font-sans);
  }
  .tab:hover { color: var(--color-text); }
  .tab.active {
    color: var(--color-brand);
    border-bottom-color: var(--color-brand);
  }

  .tab-panel { display: flex; flex-direction: column; gap: var(--space-4); }

  .kv {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-2) var(--space-4);
    margin: 0;
  }
  .kv dt {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .kv dd { margin: 0; font-size: var(--text-sm); }

  .mono { font-family: var(--font-mono); font-size: var(--text-xs); }
  .muted { color: var(--color-text-muted); font-size: var(--text-xs); }

  .cost-bar {
    height: 4px;
    background: var(--color-surface-2);
    border-radius: var(--radius-full);
    overflow: hidden;
  }
  .cost-bar-fill {
    height: 100%;
    background: var(--color-brand);
  }

  .pr-link { color: var(--color-info); text-decoration: none; }
  .pr-link:hover { text-decoration: underline; }

  .json {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-surface-2);
    color: var(--color-text);
    padding: var(--space-3);
    border-radius: var(--radius-md);
    overflow: auto;
    max-height: 480px;
    margin: 0;
    line-height: 1.5;
  }

  .error-banner {
    background: rgba(224,90,90,0.1);
    border: 1px solid rgba(224,90,90,0.3);
    border-radius: var(--radius-md);
    color: var(--color-danger);
    padding: var(--space-3);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }
  .error-banner code {
    font-family: var(--font-mono);
    background: rgba(224,90,90,0.15);
    padding: 1px 4px;
    border-radius: 3px;
  }
  .error-msg {
    background: rgba(224,90,90,0.1);
    border: 1px solid rgba(224,90,90,0.3);
    border-radius: var(--radius-md);
    color: var(--color-danger);
    font-size: var(--text-xs);
    padding: var(--space-2) var(--space-3);
  }

  .warning-banner {
    background: rgba(245,166,35,0.1);
    border: 1px solid rgba(245,166,35,0.3);
    border-radius: var(--radius-md);
    color: var(--color-warning);
    padding: var(--space-3);
    font-size: var(--text-sm);
  }
  .warning-banner ul { margin: var(--space-2) 0 0 var(--space-4); padding: 0; }

  .summary { margin: 0; font-size: var(--text-sm); line-height: 1.6; color: var(--color-text); }

  .ranked-list { display: flex; flex-direction: column; gap: var(--space-3); }
  .rank-card {
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-4);
  }
  .rank-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-bottom: var(--space-2);
  }
  .rank-num {
    font-family: var(--font-mono);
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    font-weight: 700;
  }
  .rank-title {
    margin: 0;
    font-size: var(--text-md);
    color: var(--color-text);
    flex: 1;
  }
  .rank-stats { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .rank-rationale {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    margin: var(--space-2) 0;
    line-height: 1.5;
  }
  .rank-meta {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin-top: var(--space-1);
  }
  .tag {
    display: inline-block;
    font-size: var(--text-xs);
    padding: 1px var(--space-2);
    background: var(--color-surface-2);
    border-radius: var(--radius-full);
    margin-right: var(--space-1);
    color: var(--color-text-muted);
  }

  .events-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-2);
  }
  .timeline {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .event-row {
    display: grid;
    grid-template-columns: 80px max-content 1fr;
    gap: var(--space-3);
    align-items: start;
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
  }
  .event-ts { color: var(--color-text-faint); }
  .event-payload {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin: 0;
    overflow: auto;
    max-height: 200px;
    background: transparent;
    padding: 0;
  }

  .phase-list { display: flex; flex-direction: column; gap: var(--space-2); }
  .phase-item {
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .phase-toggle {
    width: 100%;
    background: transparent;
    border: none;
    color: var(--color-text);
    padding: var(--space-3);
    text-align: left;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
  }
  .phase-toggle:hover { background: var(--color-bg-card-hover); }
  .phase-arrow { color: var(--color-text-muted); font-size: var(--text-xs); }
  .phase-name {
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: var(--text-xs);
    font-weight: 600;
  }
  .phase-body {
    padding: var(--space-3);
    border-top: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .phase-runs { font-size: var(--text-xs); color: var(--color-text-muted); }

  .file-tabs {
    display: flex;
    gap: var(--space-1);
    border-bottom: 1px solid var(--color-border);
    flex-wrap: wrap;
  }
  .file-tab {
    background: transparent;
    border: none;
    color: var(--color-text-muted);
    padding: var(--space-2) var(--space-3);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .file-tab:hover { color: var(--color-text); }
  .file-tab.active {
    color: var(--color-brand);
    border-bottom-color: var(--color-brand);
  }

  .kill-card { border-color: rgba(224,90,90,0.4); }

  @media (max-width: 700px) {
    .event-row { grid-template-columns: 1fr; }
  }
</style>
