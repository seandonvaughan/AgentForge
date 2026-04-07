<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import StageBadge from '$lib/components/StageBadge.svelte';
  import { relativeTime, formatDuration } from '$lib/util/relative-time';
  import { withWorkspace } from '$lib/stores/workspace';
  import MarkdownRenderer from '$lib/components/MarkdownRenderer.svelte';

  const TERMINAL = new Set(['completed', 'failed', 'killed']);
  const PHASES = ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn'] as const;
  const FILES = ['tests', 'git', 'pr', 'approval-pending', 'approval-decision'] as const;
  type Phase = (typeof PHASES)[number];
  type FileName = (typeof FILES)[number];
  type Tab = 'overview' | 'items' | 'agents' | 'scoring' | 'events' | 'phases' | 'files';

  let id = $derived($page.params.id);

  let cycle: any = $state(null);
  let scoring: any = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);

  let activeTab: Tab = $state('items');

  // Live sprint view — polls /cycles/:id/sprint every 3s while cycle is
  // running. Execute phase writes to the sprint file incrementally per
  // item completion, so this is the only surface that shows real-time
  // per-item progress during the long execute phase. Same beautiful kanban
  // used on /sprints/[version].
  let sprint: any = $state(null);
  let sprintLoading = $state(false);
  let sprintError: string | null = $state(null);
  let sprintPollTimer: ReturnType<typeof setInterval> | null = null;

  async function loadSprint() {
    if (!id) return;
    sprintLoading = true;
    try {
      const res = await fetch(`/api/v5/cycles/${id}/sprint`);
      if (res.ok) {
        const json = await res.json();
        sprint = json.sprint ?? json;
        sprintError = null;
      } else if (res.status === 404) {
        sprint = null;
        sprintError = 'Sprint not generated yet — still in audit/plan phase';
      } else {
        sprintError = `HTTP ${res.status}`;
      }
    } catch (e) {
      sprintError = String(e);
    } finally {
      sprintLoading = false;
    }
    // Also refresh the cycle summary (cost/tests/stage) and agents on each tick.
    try {
      const res = await fetch(`/api/v5/cycles/${id}`);
      if (res.ok) cycle = await res.json();
    } catch {}
    loadAgents();
  }

  // Agents tab state — live list of every agent run in the cycle with cost,
  // duration, per-phase aggregates, and response snippets. Polled alongside
  // the sprint endpoint so the Cost stat updates live during execute.
  let agentsData: any = $state(null);
  let agentsLoading = $state(false);
  async function loadAgents() {
    if (!id) return;
    agentsLoading = true;
    try {
      const res = await fetch(`/api/v5/cycles/${id}/agents`);
      if (res.ok) agentsData = await res.json();
    } catch {} finally { agentsLoading = false; }
  }

  function startSprintPoll() {
    if (sprintPollTimer) return;
    loadSprint();
    sprintPollTimer = setInterval(loadSprint, 3000);
  }
  function stopSprintPoll() {
    if (sprintPollTimer) { clearInterval(sprintPollTimer); sprintPollTimer = null; }
  }

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

  // Fields that contain markdown prose — rendered by MarkdownRenderer rather
  // than dumped raw into the JSON pre-block.
  const MARKDOWN_FIELDS = new Set(['review', 'rationale', 'retrospective', 'response']);

  /** Returns a copy of a phase object with markdown prose fields removed,
   *  leaving only the structured metadata that benefits from JSON display. */
  function stripMarkdownFields(data: Record<string, unknown>): Record<string, unknown> {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (!MARKDOWN_FIELDS.has(k)) copy[k] = v;
    }
    return copy;
  }

  /** Collect all markdown prose sections present in a phase object. */
  function markdownSections(data: Record<string, unknown>): Array<{ label: string; content: string }> {
    const sections: Array<{ label: string; content: string }> = [];
    for (const field of MARKDOWN_FIELDS) {
      const val = data[field];
      if (typeof val === 'string' && val.trim()) {
        sections.push({ label: field, content: val });
      }
    }
    return sections;
  }

  /** Collect markdown prose from each agentRun's response field. */
  function agentRunSections(data: Record<string, unknown>): Array<{ agentId: string; response: string }> {
    const runs = data['agentRuns'];
    if (!Array.isArray(runs)) return [];
    return runs
      .filter((r): r is Record<string, unknown> => r != null && typeof r === 'object')
      .filter((r) => typeof r['response'] === 'string' && (r['response'] as string).trim())
      .map((r) => ({
        agentId: String(r['agentId'] ?? 'agent'),
        response: r['response'] as string,
      }));
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
    loadFile('tests');
    // Start the live sprint poll immediately — this drives the Items tab
    // which is the default on load. Auto-stops when the cycle is terminal.
    startSprintPoll();
  });

  onDestroy(() => {
    teardownSse();
    stopSprintPoll();
  });

  // Auto-stop the sprint poll once the cycle hits a terminal stage.
  $effect(() => {
    void stage;
    if (isTerminal) stopSprintPoll();
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

<svelte:head><title>Cycle {id?.slice(0, 8) ?? ''} — AgentForge</title></svelte:head>

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
    <button class="tab" class:active={activeTab === 'items'} onclick={() => setTab('items')}>
      Items
      {#if sprint?.items}
        <span class="tab-count">{sprint.items.filter((i: any) => i.status === 'completed').length}/{sprint.items.length}</span>
      {/if}
    </button>
    <button class="tab" class:active={activeTab === 'agents'} onclick={() => setTab('agents')}>
      Agents
      {#if agentsData?.totalRuns != null}
        <span class="tab-count">{agentsData.totalRuns}</span>
      {/if}
    </button>
    <button class="tab" class:active={activeTab === 'overview'} onclick={() => setTab('overview')}>Overview</button>
    <button class="tab" class:active={activeTab === 'scoring'} onclick={() => setTab('scoring')}>Scoring</button>
    <button class="tab" class:active={activeTab === 'events'} onclick={() => setTab('events')}>Events</button>
    <button class="tab" class:active={activeTab === 'phases'} onclick={() => setTab('phases')}>Phases</button>
    <button class="tab" class:active={activeTab === 'files'} onclick={() => setTab('files')}>Files</button>
  </nav>

  <section class="tab-panel">
    {#if activeTab === 'items'}
      {#if sprintLoading && !sprint}
        <div class="card"><div class="skeleton" style="height:80px"></div></div>
      {:else if sprintError && !sprint}
        <div class="empty-state">
          <p>{sprintError}</p>
          <p class="muted" style="font-size: var(--text-xs); margin-top: var(--space-2);">The sprint file is created during the plan phase. Poll refreshes every 3s.</p>
        </div>
      {:else if sprint?.items}
        {@const items = sprint.items}
        {@const completed = items.filter((i: any) => i.status === 'completed')}
        {@const inProgress = items.filter((i: any) => i.status === 'in_progress')}
        {@const planned = items.filter((i: any) => i.status === 'planned' || i.status === 'pending')}
        {@const failed = items.filter((i: any) => i.status === 'failed')}
        {@const pct = items.length > 0 ? Math.round((completed.length / items.length) * 100) : 0}

        <div class="card" style="margin-bottom: var(--space-5);">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-3);">
            <div>
              <div style="font-family: var(--font-mono); font-weight: 700; font-size: var(--text-lg);">v{sprint.version ?? sprint.sprintId}</div>
              {#if sprint.title}<div class="muted" style="font-size: var(--text-sm);">{sprint.title}</div>{/if}
              {#if sprint.versionDecision}
                <div class="muted" style="font-size: var(--text-xs); margin-top: var(--space-1); font-family: var(--font-mono);">
                  {sprint.versionDecision.rationale}
                </div>
              {/if}
            </div>
            <div style="text-align: right;">
              <div style="font-size: var(--text-2xl); font-weight: 700;">{pct}%</div>
              <div class="muted" style="font-size: var(--text-xs);">{completed.length}/{items.length} items</div>
            </div>
          </div>
          <div class="cost-bar"><div class="cost-bar-fill" style="width:{pct}%"></div></div>
        </div>

        <div class="kanban">
          <div class="kanban-col">
            <div class="kanban-header">Planned <span class="kanban-count">{planned.length}</span></div>
            {#each planned as item (item.id)}
              <div class="kanban-item"><div class="item-title">{item.title}</div>{#if item.assignee}<div class="item-meta">{item.assignee}</div>{/if}</div>
            {/each}
          </div>
          <div class="kanban-col">
            <div class="kanban-header">In Progress <span class="kanban-count">{inProgress.length}</span></div>
            {#each inProgress as item (item.id)}
              <div class="kanban-item in-progress"><div class="item-title">{item.title}</div>{#if item.assignee}<div class="item-meta">{item.assignee}</div>{/if}</div>
            {/each}
          </div>
          <div class="kanban-col">
            <div class="kanban-header">Completed <span class="kanban-count">{completed.length}</span></div>
            {#each completed as item (item.id)}
              <div class="kanban-item completed"><div class="item-title">{item.title}</div>{#if item.assignee}<div class="item-meta">{item.assignee}</div>{/if}</div>
            {/each}
          </div>
          {#if failed.length > 0}
            <div class="kanban-col">
              <div class="kanban-header">Failed <span class="kanban-count">{failed.length}</span></div>
              {#each failed as item (item.id)}
                <div class="kanban-item failed"><div class="item-title">{item.title}</div>{#if item.error}<div class="item-meta">{item.error}</div>{/if}</div>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <div class="empty-state">No sprint data yet.</div>
      {/if}
    {:else if activeTab === 'agents'}
      {#if !agentsData || agentsLoading && !agentsData}
        <div class="card"><div class="skeleton" style="height:80px"></div></div>
      {:else if agentsData.totalRuns === 0}
        <div class="empty-state">No agent runs yet — cycle is still in early phases.</div>
      {:else}
        {@const agents = Object.entries(agentsData.byAgent || {}).sort((a: any, b: any) => b[1].totalCostUsd - a[1].totalCostUsd)}
        <div class="card" style="margin-bottom: var(--space-5);">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-weight: 700; font-size: var(--text-lg);">{agents.length} agents · {agentsData.totalRuns} runs</div>
              <div class="muted" style="font-size: var(--text-sm);">Live — updates every 3s</div>
            </div>
            <div style="text-align: right;">
              <div style="font-size: var(--text-2xl); font-weight: 700;">${Number(agentsData.totalCostUsd).toFixed(2)}</div>
              <div class="muted" style="font-size: var(--text-xs);">total cost</div>
            </div>
          </div>
        </div>

        <div class="agent-grid">
          {#each agents as [agentId, stats] (agentId)}
            {@const s = stats as any}
            <div class="card agent-summary">
              <div class="agent-name">{agentId}</div>
              <div class="agent-stats">
                <div><span class="muted">runs</span> <strong>{s.runs}</strong></div>
                <div><span class="muted">cost</span> <strong>${Number(s.totalCostUsd).toFixed(3)}</strong></div>
                <div><span class="muted">duration</span> <strong>{formatDuration(s.totalDurationMs)}</strong></div>
              </div>
              <div class="agent-phases">
                {#each s.phases as p}<span class="phase-chip">{p}</span>{/each}
              </div>
            </div>
          {/each}
        </div>

        <h3 style="margin-top: var(--space-5);">Run details</h3>
        <div class="run-list">
          {#each agentsData.runs as run}
            <div class="card run-row" class:failed={run.status === 'failed'}>
              <div class="run-header">
                <span class="run-phase">{run.phase}</span>
                <span class="run-agent mono">{run.agentId}</span>
                <span class="run-status {run.status}">{run.status}</span>
                {#if run.model}<span class="model-chip {run.model.replace(/[^a-z]/gi, '')}">{run.model}</span>{/if}
                {#if run.effort}<span class="effort-chip">effort: {run.effort}</span>{/if}
                {#if run.itemId}<span class="run-item muted">{run.itemId.slice(0, 60)}</span>{/if}
              </div>
              <div class="run-meta">
                <span>${Number(run.costUsd).toFixed(4)}</span>
                <span>·</span>
                <span>{formatDuration(run.durationMs)}</span>
                {#if run.attempts}<span>·</span><span>{run.attempts} attempt{run.attempts === 1 ? '' : 's'}</span>{/if}
              </div>
              {#if run.error}
                <div class="run-error">{run.error}</div>
              {:else if run.response}
                <details class="run-response">
                  <summary>Response ({run.response.length} chars)</summary>
                  <pre>{run.response.slice(0, 2000)}{run.response.length > 2000 ? '\n… (truncated)' : ''}</pre>
                </details>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {:else if activeTab === 'overview'}
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
                    {@const phaseSections = markdownSections(phaseData[phase])}
                  {@const phaseAgentRuns = agentRunSections(phaseData[phase])}
                  {@const metaOnly = stripMarkdownFields(phaseData[phase])}

                  <!-- Structured metadata (status, cost, duration, etc.) -->
                  <pre class="json">{pretty(metaOnly)}</pre>

                  <!-- Markdown prose sections (review, rationale, retrospective) -->
                  {#each phaseSections as section}
                    <div class="phase-md-section">
                      <div class="phase-md-label">{section.label}</div>
                      <MarkdownRenderer content={section.content} />
                    </div>
                  {/each}

                  <!-- Per-agent run responses rendered as markdown -->
                  {#each phaseAgentRuns as run, i}
                    <div class="phase-md-section">
                      <div class="phase-md-label">agentRun[{i}] response — {run.agentId}</div>
                      <MarkdownRenderer content={run.response} />
                    </div>
                  {/each}
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

  .phase-md-section {
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .phase-md-label {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }

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

  .tab-count {
    display: inline-block;
    margin-left: var(--space-2);
    padding: 0 var(--space-2);
    background: var(--color-bg-card);
    color: var(--color-text-muted);
    border-radius: 9999px;
    font-size: var(--text-xs);
    font-family: var(--font-mono);
  }

  .kanban {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: var(--space-4);
  }
  .kanban-col {
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    min-height: 120px;
  }
  .kanban-header {
    font-size: var(--text-xs);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-text-muted);
    padding-bottom: var(--space-2);
    margin-bottom: var(--space-2);
    border-bottom: 1px solid var(--color-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .kanban-count {
    padding: 0 var(--space-2);
    background: var(--color-bg-card);
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  .kanban-item {
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: var(--space-3);
    margin-bottom: var(--space-2);
    transition: border-color var(--duration-fast);
  }
  .kanban-item:hover { border-color: var(--color-brand); }
  .kanban-item.in-progress { border-left: 3px solid var(--color-brand); }
  .kanban-item.completed { border-left: 3px solid var(--color-success); opacity: 0.85; }
  .kanban-item.failed { border-left: 3px solid var(--color-danger); }
  .kanban-item .item-title {
    font-size: var(--text-sm);
    color: var(--color-text);
    line-height: 1.4;
    margin-bottom: var(--space-1);
  }
  .kanban-item.completed .item-title { text-decoration: line-through; color: var(--color-text-muted); }
  .kanban-item .item-meta {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
  }

  .agent-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: var(--space-3);
  }
  .agent-summary { padding: var(--space-3); }
  .agent-name {
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: var(--text-md);
    color: var(--color-text);
    margin-bottom: var(--space-2);
  }
  .agent-stats {
    display: flex;
    gap: var(--space-4);
    font-size: var(--text-sm);
    margin-bottom: var(--space-2);
  }
  .agent-phases { display: flex; flex-wrap: wrap; gap: var(--space-1); }
  .phase-chip {
    padding: 2px var(--space-2);
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: 9999px;
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--color-text-muted);
  }

  .run-list { display: flex; flex-direction: column; gap: var(--space-2); }
  .run-row { padding: var(--space-3); }
  .run-row.failed { border-left: 3px solid var(--color-danger); }
  .run-header {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    margin-bottom: var(--space-1);
    font-size: var(--text-sm);
    flex-wrap: wrap;
  }
  .run-phase {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-text-muted);
    font-weight: 700;
  }
  .run-agent { color: var(--color-brand); font-weight: 600; }
  .run-status {
    padding: 2px var(--space-2);
    border-radius: 9999px;
    font-size: var(--text-xs);
    font-family: var(--font-mono);
  }
  .run-status.completed { background: rgba(76,175,130,0.15); color: var(--color-success); }
  .run-status.failed { background: rgba(224,90,90,0.15); color: var(--color-danger); }
  .run-item { font-size: var(--text-xs); font-family: var(--font-mono); }
  .model-chip {
    padding: 2px var(--space-2);
    border-radius: 9999px;
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    font-weight: 600;
    border: 1px solid currentColor;
  }
  .model-chip[class*="opus"] { color: var(--color-opus, #f5c842); background: rgba(245,200,66,0.08); }
  .model-chip[class*="sonnet"] { color: var(--color-sonnet, #4a9eff); background: rgba(74,158,255,0.08); }
  .model-chip[class*="haiku"] { color: var(--color-haiku, #4cb071); background: rgba(76,175,130,0.08); }
  .effort-chip {
    padding: 2px var(--space-2);
    border-radius: 9999px;
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--color-text-muted);
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
  }
  .run-meta {
    display: flex;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    margin-bottom: var(--space-2);
  }
  .run-error {
    background: rgba(224,90,90,0.08);
    padding: var(--space-2);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-danger);
  }
  .run-response summary {
    cursor: pointer;
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    padding: var(--space-1) 0;
  }
  .run-response pre {
    margin-top: var(--space-2);
    padding: var(--space-2);
    background: var(--color-bg-card);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    max-height: 300px;
    overflow: auto;
    white-space: pre-wrap;
  }

  @media (max-width: 700px) {
    .event-row { grid-template-columns: 1fr; }
  }
</style>
