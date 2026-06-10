<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { withWorkspace } from '$lib/stores/workspace';
  import { relativeTime, formatDuration } from '$lib/util/relative-time';
  import {
    Btn, Card, Badge, KpiTile, StageDots, PulseDot,
  } from '$lib/components/v2';

  interface CycleRow {
    cycleId: string;
    sprintVersion: string | null;
    stage: string;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
    costUsd: number;
    budgetUsd: number;
    testsPassed: number;
    testsTotal: number;
    prUrl: string | null;
    hasApprovalPending: boolean;
    runtimeMode?: string | null;
    branchPrefix?: string | null;
    baseBranch?: string | null;
    maxAgents?: number | null;
    fastMode?: boolean | null;
    modelCap?: string | null;
    effortCap?: string | null;
    fallbackEnabled?: boolean | null;
    tags?: string[];
    dryRun?: boolean | null;
    epic?: boolean;
    childCount?: number;
  }

  type StageBrick = 'pending' | 'active' | 'done' | 'failed';
  type FilterId = 'all' | 'active' | 'success' | 'failed';
  type SortCol = 'startedAt' | 'cost' | 'duration' | 'stage' | 'tests' | 'cycle' | 'sprint';
  type SortDir = 'asc' | 'desc';
  type Density = 'comfortable' | 'compact';

  const TERMINAL = new Set(['completed', 'failed', 'killed', 'crashed']);
  const POLL_MS = 5000;

  let cycles = $state<CycleRow[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  let filter = $state<FilterId>('all');
  let sortCol = $state<SortCol>('startedAt');
  let sortDir = $state<SortDir>('desc');
  let selected = $state<string[]>([]);
  let density = $state<Density>('comfortable');
  let comparing = $state(false);
  let searchQ = $state('');
  let costThreshold = $state<number | null>(null);

  async function loadCycles(): Promise<void> {
    try {
      const res = await fetch(withWorkspace('/api/v5/cycles?limit=200'));
      if (!res.ok) { error = `HTTP ${res.status}`; return; }
      const json = (await res.json()) as { cycles?: CycleRow[] };
      cycles = (json.cycles ?? []).slice();
      error = null;
      managePolling();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  interface PreviewRow {
    id: string;
    status: string;
    title: string;
    childCount: number;
    waveCount: number;
    plannerCostUsd: number;
    budgetUsd: number | null;
    withinBand: boolean | null;
    createdAt: string | null;
  }
  let previews = $state<PreviewRow[]>([]);

  async function loadPreviews(): Promise<void> {
    try {
      const res = await fetch(withWorkspace('/api/v5/previews'));
      if (!res.ok) return;
      const json = (await res.json()) as { previews?: PreviewRow[] };
      previews = (json.previews ?? []).slice(0, 10);
    } catch { /* non-fatal — section simply stays hidden */ }
  }

  function hasActive(): boolean {
    return cycles.some((c) => !TERMINAL.has((c.stage ?? '').toLowerCase()));
  }

  function managePolling(): void {
    const paused = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (paused) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      return;
    }
    if (hasActive()) {
      if (!pollTimer) pollTimer = setInterval(loadCycles, POLL_MS);
    } else if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function onVisibilityChange(): void { managePolling(); }

  function bricksFor(c: CycleRow): StageBrick[] {
    const stage = (c.stage ?? '').toLowerCase();
    const order: Record<string, number> = {
      plan: 0, audit: 0,
      stage: 1, assign: 1,
      run: 2, execute: 2,
      verify: 3, test: 3,
      commit: 4, gate: 4, review: 4,
      release: 5, learn: 5,
      completed: 6,
      failed: -1,
      killed: -1,
      crashed: -1,
    };
    const out: StageBrick[] = Array.from({ length: 6 }, () => 'pending');
    if (stage === 'completed') return out.map(() => 'done' as StageBrick);
    if (stage === 'failed' || stage === 'killed' || stage === 'crashed') {
      const idx = 1;
      for (let i = 0; i < idx; i++) out[i] = 'done';
      out[idx] = 'failed';
      return out;
    }
    const idx = order[stage];
    if (idx == null || idx < 0) return out;
    for (let i = 0; i < Math.min(idx, 6); i++) out[i] = 'done';
    if (idx < 6) out[idx] = 'active';
    return out;
  }

  function shortId(id: string): string {
    return (id ?? '').slice(0, 8);
  }

  function isTerminal(c: CycleRow): boolean {
    return TERMINAL.has((c.stage ?? '').toLowerCase());
  }

  function stageBadgeVariant(stage: string): 'success' | 'danger' | 'purple' | 'muted' {
    const s = stage.toLowerCase();
    if (s === 'completed') return 'success';
    if (s === 'failed' || s === 'killed' || s === 'crashed') return 'danger';
    if (TERMINAL.has(s)) return 'muted';
    return 'purple';
  }

  function isCodexCli(c: CycleRow): boolean {
    return (c.runtimeMode ?? '').toLowerCase() === 'codex-cli';
  }

  function epicLabel(c: CycleRow): string {
    const n = c.childCount ?? 0;
    if (n <= 0) return 'epic';
    return `epic · ${n} ${n === 1 ? 'child' : 'children'}`;
  }

  function hasCycleConfig(c: CycleRow): boolean {
    return isCodexCli(c) ||
      !!c.branchPrefix ||
      !!c.baseBranch ||
      typeof c.maxAgents === 'number' ||
      c.fastMode === true ||
      !!c.modelCap ||
      !!c.effortCap ||
      typeof c.fallbackEnabled === 'boolean' ||
      typeof c.dryRun === 'boolean' ||
      (c.tags?.length ?? 0) > 0;
  }

  const filtered = $derived.by<CycleRow[]>(() => {
    let rows = cycles.filter((c) => {
      const s = (c.stage ?? '').toLowerCase();
      if (filter === 'all') return true;
      if (filter === 'active') return !TERMINAL.has(s);
      if (filter === 'success') return s === 'completed';
      if (filter === 'failed') return s === 'failed' || s === 'killed' || s === 'crashed';
      return true;
    });
    if (searchQ.trim()) {
      const q = searchQ.toLowerCase();
      rows = rows.filter((c) =>
        c.cycleId.toLowerCase().includes(q) ||
        (c.sprintVersion ?? '').toLowerCase().includes(q) ||
        (c.runtimeMode ?? '').toLowerCase().includes(q) ||
        (c.baseBranch ?? '').toLowerCase().includes(q) ||
        (c.branchPrefix ?? '').toLowerCase().includes(q) ||
        (c.tags ?? []).some((tag) => tag.toLowerCase().includes(q)),
      );
    }
    if (costThreshold != null && costThreshold > 0) {
      rows = rows.filter((c) => c.costUsd <= costThreshold!);
    }
    rows = [...rows].sort((a, b) => {
      const sgn = sortDir === 'asc' ? 1 : -1;
      const va = sortVal(a, sortCol);
      const vb = sortVal(b, sortCol);
      if (va < vb) return -1 * sgn;
      if (va > vb) return 1 * sgn;
      return 0;
    });
    return rows;
  });

  function sortVal(c: CycleRow, col: SortCol): number | string {
    switch (col) {
      case 'startedAt': return new Date(c.startedAt).getTime();
      case 'cost': return c.costUsd ?? 0;
      case 'duration': return c.durationMs ?? 0;
      case 'stage': return c.stage ?? '';
      case 'tests': return c.testsTotal > 0 ? c.testsPassed / c.testsTotal : 0;
      case 'cycle': return c.cycleId;
      case 'sprint': return c.sprintVersion ?? '';
    }
  }

  function toggleSort(col: SortCol): void {
    if (sortCol === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else { sortCol = col; sortDir = 'desc'; }
  }

  function toggleRow(id: string): void {
    if (selected.includes(id)) {
      selected = selected.filter((x) => x !== id);
    } else if (selected.length >= 3) {
      selected = [...selected.slice(1), id];
    } else {
      selected = [...selected, id];
    }
  }

  function clearSelected(): void { selected = []; }

  const stats = $derived.by(() => {
    const total = cycles.length;
    const completed = cycles.filter((c) => c.stage === 'completed');
    const failed = cycles.filter((c) => {
      const s = c.stage.toLowerCase();
      return s === 'failed' || s === 'killed' || s === 'crashed';
    });
    const passRate = total > 0 ? (completed.length / total) * 100 : 0;
    const avgCost = completed.length > 0
      ? completed.reduce((s, c) => s + c.costUsd, 0) / completed.length
      : 0;
    const avgDurationMs = completed.length > 0
      ? completed.reduce((s, c) => s + (c.durationMs ?? 0), 0) / completed.length
      : 0;
    const totalSpend = cycles.reduce((s, c) => s + c.costUsd, 0);
    return { total, completed: completed.length, failed: failed.length, passRate, avgCost, totalSpend, avgDurationMs };
  });

  const costSparkline = $derived.by(() => {
    const recent = [...cycles]
      .filter((c) => c.stage === 'completed')
      .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
      .slice(-12)
      .map((c) => c.costUsd);
    return recent.length > 1 ? recent : [0, 0];
  });

  const passRateSpark = $derived.by(() => {
    const sorted = [...cycles].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
    const buckets = 7;
    if (sorted.length === 0) return [0, 0];
    const size = Math.max(1, Math.ceil(sorted.length / buckets));
    const out: number[] = [];
    for (let i = 0; i < buckets; i++) {
      const slice = sorted.slice(i * size, (i + 1) * size);
      if (slice.length === 0) continue;
      const pass = slice.filter((c) => c.stage === 'completed').length;
      out.push((pass / slice.length) * 100);
    }
    return out.length > 1 ? out : [...out, ...out];
  });

  function openCompare(): void { if (selected.length >= 2) comparing = true; }
  function closeCompare(): void { comparing = false; }

  const compareCycles = $derived<CycleRow[]>(
    selected.map((id) => cycles.find((c) => c.cycleId === id)).filter((c): c is CycleRow => !!c),
  );

  function onRowClick(c: CycleRow): void { void goto(`/cycles/${c.cycleId}`); }
  function onRowKey(e: KeyboardEvent, c: CycleRow): void {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(c); }
  }

  onMount(() => {
    void loadCycles();
    void loadPreviews();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  });
</script>

<svelte:head><title>Cycles — AgentForge</title></svelte:head>

<div class="page-head">
  <div>
    <div class="crumbs af2-mono">Workspace · Cycles</div>
    <h1 class="page-title">Cycles</h1>
    <p class="page-sub"><span class="af2-mono">{cycles.length}</span> total · autonomous sprint history</p>
  </div>
  <div class="head-actions">
    <div class="density-toggle">
      {#each [['comfortable', '☰'], ['compact', '☷']] as [id, ic] (id)}
        <button
          type="button"
          class="density-btn"
          class:density-on={density === id}
          onclick={() => (density = id as Density)}
          title={id as string}
          aria-label={id as string}
        >{ic}</button>
      {/each}
    </div>
    <Btn size="sm" onClick={loadCycles}>{loading ? 'Refreshing…' : 'Refresh'}</Btn>
    <Btn size="sm" variant="purple" href="/cycles/new">+ New Cycle</Btn>
  </div>
</div>

{#if error}
  <Card style="margin-bottom:14px;border-color:color-mix(in srgb,var(--af-danger) 30%,transparent)">
    <div class="error-row">
      <span>Failed to load cycles: <code>{error}</code></span>
      <Btn size="sm" onClick={loadCycles}>Retry</Btn>
    </div>
  </Card>
{/if}

<div class="stats-strip">
  <KpiTile label="Total" value={stats.total} color="var(--af-text)" sparkline={passRateSpark} />
  <KpiTile label="Pass rate" value={`${stats.passRate.toFixed(1)}%`} color="var(--af-success)" sparkline={passRateSpark} />
  <KpiTile label="Avg cost" value={`$${stats.avgCost.toFixed(2)}`} color="var(--af-purple)" sparkline={costSparkline} />
  <KpiTile label="Avg time" value={stats.avgDurationMs > 0 ? formatDuration(stats.avgDurationMs) : '—'} color="var(--af-sonnet)" />
  <KpiTile label="Total spend" value={`$${stats.totalSpend.toFixed(2)}`} color="var(--af-warning)" sparkline={costSparkline} />
</div>

<div class="filter-bar">
  {#each [
    { id: 'all',     label: 'All',       count: cycles.length, c: 'var(--af-muted)' },
    { id: 'active',  label: 'Running',   count: cycles.filter((c) => !TERMINAL.has(c.stage.toLowerCase())).length, c: 'var(--af-purple)' },
    { id: 'success', label: 'Completed', count: cycles.filter((c) => c.stage === 'completed').length, c: 'var(--af-success)' },
    { id: 'failed',  label: 'Failed',    count: cycles.filter((c) => { const s = c.stage.toLowerCase(); return s === 'failed' || s === 'killed' || s === 'crashed'; }).length, c: 'var(--af-danger)' },
  ] as f (f.id)}
    <button
      type="button"
      class="chip"
      class:chip-active={filter === f.id}
      onclick={() => (filter = f.id as FilterId)}
    >
      <span class="chip-count af2-mono" style="color:{filter === f.id ? f.c : 'var(--af-faint)'}">{f.count}</span>
      {f.label}
    </button>
  {/each}

  <div class="filter-spacer"></div>

  <label class="filter-input">
    <span>Max cost</span>
    <input
      type="number"
      min="0"
      step="1"
      placeholder="any"
      value={costThreshold ?? ''}
      onchange={(e) => {
        const v = (e.target as HTMLInputElement).value;
        costThreshold = v === '' ? null : Number(v);
      }}
    />
  </label>

  <label class="filter-input">
    <span>Search</span>
    <input type="text" placeholder="cycle id / sprint…" bind:value={searchQ} />
  </label>
</div>

{#if loading && cycles.length === 0}
  <Card noPad>
    <div style="padding:16px;display:flex;flex-direction:column;gap:8px">
      <div class="skeleton-row"></div>
      <div class="skeleton-row"></div>
      <div class="skeleton-row"></div>
    </div>
  </Card>
{:else if filtered.length === 0 && !error}
  <Card>
    <div class="empty">
      <div class="empty-icon">∅</div>
      {#if cycles.length === 0}
        <p>No cycles yet.</p>
        <p class="empty-sub">Run one with <code>npm run autonomous:cycle</code> or click <strong>+ New Cycle</strong>.</p>
        <div style="margin-top:12px"><Btn size="md" variant="purple" href="/cycles/new">+ New Cycle</Btn></div>
      {:else}
        <p>No cycles match your filter.</p>
        <p class="empty-sub">Clear the filter or change the search term to see all cycles.</p>
      {/if}
    </div>
  </Card>
{:else}
  <Card noPad>
    <div class="table-wrap">
      <table class="cycles-table" class:compact={density === 'compact'}>
        <thead>
          <tr>
            <th class="col-check">
              <input
                type="checkbox"
                checked={selected.length > 0 && filtered.slice(0, 3).every((c) => selected.includes(c.cycleId))}
                onchange={() => {
                  const allSel = selected.length > 0 && filtered.slice(0, 3).every((c) => selected.includes(c.cycleId));
                  selected = allSel ? [] : filtered.slice(0, 3).map((c) => c.cycleId);
                }}
                aria-label="Select up to 3 cycles to compare"
              />
            </th>
            <th>Stage</th>
            <th class="sortable" onclick={() => toggleSort('cycle')}>
              Cycle{#if sortCol === 'cycle'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
            </th>
            <th class="sortable" onclick={() => toggleSort('sprint')}>
              Sprint{#if sortCol === 'sprint'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
            </th>
            <th class="sortable" onclick={() => toggleSort('startedAt')}>
              Started{#if sortCol === 'startedAt'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
            </th>
            <th class="sortable" onclick={() => toggleSort('duration')}>
              Duration{#if sortCol === 'duration'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
            </th>
            <th class="sortable" onclick={() => toggleSort('cost')}>
              Cost{#if sortCol === 'cost'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
            </th>
            <th class="sortable" onclick={() => toggleSort('tests')}>
              Tests{#if sortCol === 'tests'}<span class="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
            </th>
            <th>PR</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {#each filtered as c (c.cycleId)}
            {@const isSel = selected.includes(c.cycleId)}
            {@const isLive = !isTerminal(c)}
            {@const costPct = c.budgetUsd > 0 ? Math.min(100, (c.costUsd / c.budgetUsd) * 100) : 0}
            <tr
              class="row"
              class:row-selected={isSel}
              class:row-active={isLive}
              tabindex="0"
              onclick={() => onRowClick(c)}
              onkeydown={(e) => onRowKey(e, c)}
            >
              <td class="col-check" onclick={(e) => { e.stopPropagation(); toggleRow(c.cycleId); }}>
                <input type="checkbox" checked={isSel} onchange={() => {}} aria-label="Select cycle for compare" />
              </td>
              <td><StageDots stages={bricksFor(c)} /></td>
              <td>
                <div class="cycle-cell">
                  {#if isLive}<PulseDot color="var(--af-purple)" size={5} />{/if}
                  <span class="af2-mono cycle-id">{shortId(c.cycleId)}</span>
                  {#if c.epic === true}
                    <span class="epic-pill" title="Objective epic cycle">{epicLabel(c)}</span>
                  {/if}
                </div>
                {#if hasCycleConfig(c)}
                  <div class="config-chips" aria-label="Cycle launch configuration">
                    {#if isCodexCli(c)}<Badge variant="purple">Codex CLI</Badge>{/if}
                    {#if typeof c.dryRun === 'boolean'}<span class="config-chip">dry run {c.dryRun ? 'on' : 'off'}</span>{/if}
                    {#if typeof c.maxAgents === 'number'}<span class="config-chip af2-mono">{c.maxAgents} agents</span>{/if}
                    {#if c.fastMode === true}<span class="config-chip">fast mode</span>{/if}
                    {#if c.modelCap}<span class="config-chip af2-mono">profile {c.modelCap}</span>{/if}
                    {#if c.effortCap}<span class="config-chip af2-mono">effort {c.effortCap}</span>{/if}
                    {#if typeof c.fallbackEnabled === 'boolean'}<span class="config-chip">fallback {c.fallbackEnabled ? 'on' : 'off'}</span>{/if}
                    {#if c.baseBranch}<span class="config-chip af2-mono">base {c.baseBranch}</span>{/if}
                    {#if c.branchPrefix}<span class="config-chip af2-mono">prefix {c.branchPrefix}</span>{/if}
                    {#each (c.tags ?? []) as tag (tag)}
                      <span class="config-chip">#{tag}</span>
                    {/each}
                  </div>
                {/if}
              </td>
              <td><span class="af2-mono muted">{c.sprintVersion ?? '—'}</span></td>
              <td><span class="dim">{relativeTime(c.startedAt)}</span></td>
              <td><span class="af2-mono">{formatDuration(c.durationMs)}</span></td>
              <td class="col-cost">
                <div class="af2-mono cost-val">
                  ${c.costUsd.toFixed(2)} <span class="dim">/ ${c.budgetUsd.toFixed(0)}</span>
                </div>
                <div class="cost-bar"><div class="cost-bar-fill" style="width:{costPct}%"></div></div>
              </td>
              <td>
                {#if c.testsTotal > 0}
                  <span class="af2-mono">{c.testsPassed}/{c.testsTotal}</span>
                {:else}
                  <span class="faint">—</span>
                {/if}
              </td>
              <td>
                {#if c.prUrl}
                  <a class="pr-link af2-mono" href={c.prUrl} target="_blank" rel="noopener" onclick={(e) => e.stopPropagation()}>PR ↗</a>
                {:else}
                  <span class="faint">—</span>
                {/if}
              </td>
              <td><Badge variant={stageBadgeVariant(c.stage)}>{c.stage.toUpperCase()}</Badge></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>
{/if}

{#if filtered.length > 100}
  <div class="muted" style="text-align:center;margin-top:10px;font-size:11px">
    Showing <span class="af2-mono">{filtered.length}</span> cycles · server caps at 200
  </div>
{/if}

{#if previews.length > 0}
  <Card style="margin-top:14px">
    <div class="cc-section-title">OBJECTIVE PREVIEWS</div>
    <div class="muted" style="font-size:11px;margin-bottom:8px">
      Rehearsals from <span class="af2-mono">cycle preview --objective</span> — planner + validation only, nothing executed.
    </div>
    {#each previews as p (p.id)}
      <div class="preview-row">
        <Badge variant={p.status === 'ok' ? 'success' : 'danger'}>{p.status.toUpperCase()}</Badge>
        <span class="preview-title">{p.title}</span>
        <span class="af2-mono dim">
          {p.childCount} children · {p.waveCount} waves
          {#if p.budgetUsd != null} · ${p.budgetUsd.toFixed(0)} budget{/if}
          {#if p.withinBand === false} · OUT OF BAND{/if}
          · planner ${p.plannerCostUsd.toFixed(2)}
        </span>
        {#if p.createdAt}<span class="af2-mono dim">{relativeTime(p.createdAt)}</span>{/if}
      </div>
    {/each}
  </Card>
{/if}

{#if selected.length > 0}
  <div class="compare-bar" role="region" aria-label="Compare cycles selection">
    <span class="af2-mono">
      <span style="color:var(--af-purple);font-weight:700">{selected.length}</span> selected
      {#if selected.length < 2}<span class="faint">· pick 2-3 to compare</span>{/if}
    </span>
    <div class="compare-chips">
      {#each selected as id (id)}
        <span class="compare-chip af2-mono">
          {shortId(id)}
          <button type="button" onclick={() => toggleRow(id)} aria-label="Deselect">×</button>
        </span>
      {/each}
    </div>
    <div class="compare-bar-spacer"></div>
    <Btn size="sm" onClick={clearSelected}>Clear</Btn>
    <Btn size="sm" variant="purple" disabled={selected.length < 2} onClick={openCompare}>
      Compare {selected.length} →
    </Btn>
  </div>
{/if}

{#if comparing && compareCycles.length >= 2}
  <div class="compare-overlay" role="dialog" aria-modal="true" aria-label="Compare cycles" onclick={closeCompare}>
    <div class="compare-drawer" onclick={(e) => e.stopPropagation()}>
      <div class="compare-head">
        <div>
          <h2 class="compare-title">Compare cycles</h2>
          <p class="compare-sub">{compareCycles.length} cycles side-by-side</p>
        </div>
        <button type="button" class="compare-close" onclick={closeCompare} aria-label="Close">×</button>
      </div>

      <div class="compare-body">
        <div class="compare-cards" style="grid-template-columns:repeat({compareCycles.length},1fr)">
          {#each compareCycles as c (c.cycleId)}
            <Card>
              <div class="cc-head">
                {#if !isTerminal(c)}<PulseDot color="var(--af-purple)" size={5} />{/if}
                <span class="af2-mono cc-id">{shortId(c.cycleId)}</span>
                <Badge variant={stageBadgeVariant(c.stage)}>{c.stage.toUpperCase()}</Badge>
              </div>
              <div class="cc-meta af2-mono">v{c.sprintVersion ?? '—'} · {relativeTime(c.startedAt)}</div>
              {#if hasCycleConfig(c)}
                <div class="config-chips compare-config">
                  {#if isCodexCli(c)}<Badge variant="purple">Codex CLI</Badge>{/if}
                  {#if typeof c.dryRun === 'boolean'}<span class="config-chip">dry run {c.dryRun ? 'on' : 'off'}</span>{/if}
                  {#if typeof c.maxAgents === 'number'}<span class="config-chip af2-mono">{c.maxAgents} agents</span>{/if}
                  {#if c.fastMode === true}<span class="config-chip">fast mode</span>{/if}
                  {#if c.modelCap}<span class="config-chip af2-mono">profile {c.modelCap}</span>{/if}
                  {#if c.effortCap}<span class="config-chip af2-mono">effort {c.effortCap}</span>{/if}
                  {#if typeof c.fallbackEnabled === 'boolean'}<span class="config-chip">fallback {c.fallbackEnabled ? 'on' : 'off'}</span>{/if}
                  {#if c.baseBranch}<span class="config-chip af2-mono">base {c.baseBranch}</span>{/if}
                </div>
              {/if}
              <div style="margin:10px 0"><StageDots stages={bricksFor(c)} /></div>
              <div class="cc-grid">
                <div>
                  <div class="cc-label">Cost</div>
                  <div class="cc-val af2-mono">${c.costUsd.toFixed(2)}</div>
                  <div class="cc-sub af2-mono">of ${c.budgetUsd.toFixed(0)}</div>
                </div>
                <div>
                  <div class="cc-label">Duration</div>
                  <div class="cc-val af2-mono">{formatDuration(c.durationMs)}</div>
                </div>
              </div>
              <div style="margin-top:10px">
                <Btn size="sm" href={`/cycles/${c.cycleId}`}>Open detail →</Btn>
              </div>
            </Card>
          {/each}
        </div>

        <Card style="margin-top:14px">
          <div class="cc-section-title">STAGE COMPLETION</div>
          <div class="cc-stage-rows">
            {#each ['PLAN','STAGE','RUN','VERIFY','COMMIT','REVIEW'] as name, idx (name)}
              <div class="cc-stage-row" style="grid-template-columns:80px repeat({compareCycles.length},1fr)">
                <span class="af2-mono cc-stage-name">{name}</span>
                {#each compareCycles as c (c.cycleId)}
                  {@const s = bricksFor(c)[idx]!}
                  <div class="cc-stage-cell" data-state={s}>
                    {s === 'done' ? '✓ done' : s === 'active' ? '◐ active' : s === 'failed' ? '✗ failed' : 'pending'}
                  </div>
                {/each}
              </div>
            {/each}
          </div>
        </Card>

        <Card style="margin-top:12px">
          <div class="cc-section-title">METRICS COMPARISON</div>
          {#each ([
            { label: 'Cost',            get: (c: CycleRow) => c.costUsd,            fmt: (v: number) => `$${v.toFixed(2)}`,      better: 'low' },
            { label: 'Budget',          get: (c: CycleRow) => c.budgetUsd,          fmt: (v: number) => `$${v.toFixed(0)}`,      better: null },
            { label: 'Cost / budget',   get: (c: CycleRow) => c.budgetUsd > 0 ? (c.costUsd / c.budgetUsd) * 100 : 0, fmt: (v: number) => `${v.toFixed(0)}%`, better: 'low' },
            { label: 'Duration (ms)',   get: (c: CycleRow) => c.durationMs ?? 0,    fmt: (v: number) => v > 0 ? formatDuration(v) : '—', better: 'low' },
            { label: 'Tests passed',    get: (c: CycleRow) => c.testsPassed,        fmt: (v: number) => v.toString(),            better: 'high' },
            { label: 'Tests total',     get: (c: CycleRow) => c.testsTotal,         fmt: (v: number) => v.toString(),            better: null },
          ] as { label: string; get: (c: CycleRow) => number; fmt: (v: number) => string; better: 'low' | 'high' | null }[]) as m (m.label)}
            {@const vals = compareCycles.map(m.get)}
            {@const best = m.better === 'low'
              ? Math.min(...vals)
              : m.better === 'high'
                ? Math.max(...vals)
                : null}
            <div class="cc-metric-row" style="grid-template-columns:140px repeat({compareCycles.length},1fr)">
              <span class="cc-metric-label">{m.label}</span>
              {#each compareCycles as c (c.cycleId)}
                {@const v = m.get(c)}
                {@const isBest = best != null && v === best}
                <span class="af2-mono" class:cc-best={isBest}>
                  {m.fmt(v)}{#if isBest}<span class="cc-star">★</span>{/if}
                </span>
              {/each}
            </div>
          {/each}
        </Card>
      </div>
    </div>
  </div>
{/if}

<style>
  .page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 14px;
    gap: 16px;
    flex-wrap: wrap;
  }
  .crumbs {
    font-size: 11px;
    color: var(--af-dim);
    letter-spacing: 0.04em;
    margin-bottom: 4px;
  }
  .page-title {
    font-size: 22px;
    font-weight: 700;
    color: var(--af-text);
    margin: 0;
    letter-spacing: -0.02em;
  }
  .page-sub { font-size: 12px; color: var(--af-dim); margin: 4px 0 0; }
  .head-actions { display: flex; gap: 8px; align-items: center; }
  .density-toggle {
    display: flex;
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    padding: 2px;
  }
  .density-btn {
    background: none;
    border: none;
    padding: 4px 10px;
    border-radius: 4px;
    color: var(--af-dim);
    cursor: pointer;
    font-size: 12px;
  }
  .density-on { background: var(--af-surface2); color: var(--af-text); }
  .stats-strip {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 8px;
    margin-bottom: 12px;
  }
  @media (max-width: 1100px) { .stats-strip { grid-template-columns: repeat(2, 1fr); } }
  .filter-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .filter-spacer { flex: 1; min-width: 8px; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border-radius: 999px;
    font-size: 11px;
    background: transparent;
    border: 1px solid var(--af-border2);
    color: var(--af-dim);
    cursor: pointer;
    transition: all 150ms ease;
    font-weight: 500;
    font-family: inherit;
  }
  .chip:hover { color: var(--af-muted); }
  .chip-active {
    background: var(--af-surface2);
    border-color: var(--af-border3);
    color: var(--af-text);
  }
  .chip-count { font-size: 10px; font-weight: 700; }
  .filter-input {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--af-dim);
  }
  .filter-input input {
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    color: var(--af-text);
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 12px;
    font-family: inherit;
    height: 30px;
    width: 140px;
  }
  .filter-input input:focus { outline: none; border-color: var(--af-purple); }
  .error-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--af-danger);
    font-size: 12px;
  }
  .error-row code {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    background: color-mix(in srgb, var(--af-danger) 12%, transparent);
    padding: 1px 5px;
    border-radius: 3px;
  }
  .skeleton-row {
    height: 28px;
    background: linear-gradient(90deg, var(--af-surface) 0%, var(--af-surface2) 50%, var(--af-surface) 100%);
    background-size: 200% 100%;
    animation: skel 1.4s linear infinite;
    border-radius: 4px;
  }
  @keyframes skel {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .skeleton-row { animation: none; background: var(--af-surface2); }
  }
  .table-wrap { overflow-x: auto; }
  .cycles-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .cycles-table th {
    text-align: left;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--af-dim);
    padding: 10px 14px;
    border-bottom: 1px solid var(--af-border);
    white-space: nowrap;
    user-select: none;
  }
  .cycles-table .sortable { cursor: pointer; }
  .cycles-table .sortable:hover { color: var(--af-muted); }
  .sort-arrow { color: var(--af-purple); font-size: 9px; margin-left: 4px; }
  .cycles-table td {
    padding: 8px 14px;
    border-bottom: 1px solid var(--af-border);
    color: var(--af-text);
    white-space: nowrap;
  }
  .cycles-table.compact td { padding: 5px 12px; }
  .row { cursor: pointer; transition: background 150ms ease; }
  .row:hover { background: color-mix(in srgb, var(--af-surface2) 60%, transparent); }
  .row:focus-visible { outline: 1px solid var(--af-purple); outline-offset: -1px; }
  .row-selected { background: color-mix(in srgb, var(--af-purple) 8%, transparent); }
  .row-active   { background: color-mix(in srgb, var(--af-purple) 4%, transparent); }
  .col-check { width: 32px; }
  .col-check input { accent-color: var(--af-purple); cursor: pointer; }
  .cycle-cell { display: inline-flex; align-items: center; gap: 8px; }
  .cycle-id { font-weight: 600; color: var(--af-text); }
  .epic-pill {
    display: inline-flex;
    align-items: center;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
    color: var(--af-purple);
    background: color-mix(in srgb, var(--af-purple) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-purple) 33%, transparent);
  }
  .config-chips {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    max-width: 360px;
    margin-top: 5px;
  }
  .config-chip {
    display: inline-flex;
    align-items: center;
    min-height: 18px;
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--af-border2);
    background: var(--af-surface);
    color: var(--af-dim);
    font-size: 10px;
    line-height: 1.35;
    white-space: normal;
  }
  .compare-config { margin: 8px 0 0; max-width: none; }
  .col-cost { min-width: 140px; }
  .cost-val { font-size: 11px; color: var(--af-text); }
  .cost-bar {
    height: 2px;
    width: 90px;
    background: var(--af-border);
    border-radius: 1px;
    margin-top: 3px;
    overflow: hidden;
  }
  .cost-bar-fill {
    height: 100%;
    background: var(--af-grad-h, linear-gradient(90deg, var(--af-accent), var(--af-purple)));
  }
  .pr-link { font-size: 11px; color: var(--af-accent2); text-decoration: none; }
  .pr-link:hover { text-decoration: underline; }
  .dim   { color: var(--af-dim);   font-size: 11px; }
  .muted { color: var(--af-muted); }
  .faint { color: var(--af-faint); font-size: 11px; }
  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1, 'ss01' 1;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 36px 16px;
    color: var(--af-muted);
    text-align: center;
  }
  .empty-icon { font-size: 28px; color: var(--af-faint); margin-bottom: 8px; }
  .empty p { margin: 4px 0; font-size: 13px; }
  .empty-sub { color: var(--af-dim); font-size: 11px; }
  .empty code {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    background: var(--af-surface2);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 11px;
  }
  .compare-bar {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--af-surface);
    border: 1px solid color-mix(in srgb, var(--af-purple) 33%, transparent);
    border-radius: 10px;
    padding: 10px 14px;
    display: flex;
    align-items: center;
    gap: 14px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.6), 0 0 0 1px color-mix(in srgb, var(--af-purple) 10%, transparent);
    z-index: 80;
    font-size: 11px;
    color: var(--af-muted);
    animation: af2fade 200ms ease-out;
  }
  @keyframes af2fade {
    from { opacity: 0; transform: translate(-50%, 6px); }
    to   { opacity: 1; transform: translate(-50%, 0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .compare-bar { animation: none; }
  }
  .compare-chips { display: flex; gap: 4px; }
  .compare-chip {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    color: var(--af-text);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .compare-chip button {
    background: none;
    border: none;
    color: var(--af-dim);
    cursor: pointer;
    padding: 0;
    font-size: 12px;
    line-height: 1;
  }
  .compare-bar-spacer { flex: 1; }
  .compare-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    z-index: 100;
    display: flex;
    align-items: stretch;
    justify-content: flex-end;
  }
  .compare-drawer {
    width: min(1200px, 92vw);
    height: 100%;
    background: var(--af-bg);
    border-left: 1px solid var(--af-border);
    display: flex;
    flex-direction: column;
    box-shadow: -12px 0 60px rgba(0,0,0,0.6);
  }
  .compare-head {
    padding: 16px 24px;
    border-bottom: 1px solid var(--af-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .compare-title {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--af-text);
  }
  .compare-sub { margin: 3px 0 0; font-size: 11px; color: var(--af-dim); }
  .compare-close {
    width: 30px;
    height: 30px;
    border-radius: 6px;
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    color: var(--af-muted);
    cursor: pointer;
    font-size: 16px;
  }
  .compare-body { flex: 1; overflow: auto; padding: 20px; }
  .compare-cards { display: grid; gap: 12px; }
  .cc-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .cc-id { font-size: 14px; font-weight: 700; color: var(--af-text); }
  .cc-meta { font-size: 11px; color: var(--af-dim); }
  .cc-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 4px;
  }
  .cc-label {
    font-size: 10px;
    color: var(--af-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .cc-val {
    font-size: 16px;
    font-weight: 600;
    color: var(--af-text);
    margin-top: 2px;
  }
  .cc-sub { font-size: 10px; color: var(--af-dim); }
  .cc-section-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    text-transform: uppercase;
    margin-bottom: 12px;
  }
  .cc-stage-rows { display: flex; flex-direction: column; gap: 8px; }
  .cc-stage-row { display: grid; gap: 12px; align-items: center; }
  .cc-stage-name {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--af-dim);
  }
  .cc-stage-cell {
    height: 26px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
    background: var(--af-surface);
    border: 1px solid var(--af-border);
    color: var(--af-faint);
  }
  .cc-stage-cell[data-state='done'] {
    background: color-mix(in srgb, var(--af-accent) 12%, transparent);
    border-color: color-mix(in srgb, var(--af-accent) 33%, transparent);
    color: var(--af-accent2);
  }
  .cc-stage-cell[data-state='active'] {
    background: color-mix(in srgb, var(--af-purple) 16%, transparent);
    border-color: color-mix(in srgb, var(--af-purple) 33%, transparent);
    color: var(--af-purple);
  }
  .cc-stage-cell[data-state='failed'] {
    background: color-mix(in srgb, var(--af-danger) 12%, transparent);
    border-color: color-mix(in srgb, var(--af-danger) 33%, transparent);
    color: var(--af-danger);
  }
  .cc-metric-row {
    display: grid;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid var(--af-border);
    align-items: center;
    font-size: 12px;
    color: var(--af-text);
  }
  .cc-metric-row:last-child { border-bottom: none; }
  .cc-metric-label { font-size: 11px; color: var(--af-dim); }
  .cc-best { color: var(--af-success); font-weight: 600; }
  .cc-star { margin-left: 4px; font-size: 9px; }

  .preview-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
    border-bottom: 1px solid var(--af-border);
    font-size: 12px;
  }
  .preview-row:last-child { border-bottom: none; }
  .preview-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
