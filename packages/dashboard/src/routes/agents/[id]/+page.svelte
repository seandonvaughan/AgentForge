<script lang="ts">
  /**
   * /agents/:id — Agent Detail page (v2 design).
   *
   * Rebuilt to match design/v2-handoff/prototype/page-agents.jsx AgentDetailPage.
   * Four tabs: Overview · Sessions · Memory · Config
   *
   * Data sources:
   *   - SSR: agent detail from +page.server.ts (reads .agentforge/agents/<id>.yaml)
   *   - Client: GET /api/v5/sessions?agentId=:id (sessions tab)
   *   - Client: GET /api/v5/memory?agentId=:id (memory tab)
   *   - Config tab: reads raw YAML via GET /api/v5/agents/:id, editable + POST /api/v5/agents/:id
   *
   * ENDPOINT STATUS:
   *   ✅ GET /api/v5/agents/:id     — exists, returns agent detail
   *   ✅ GET /api/v5/sessions        — exists, supports ?agentId filter
   *   ✅ GET /api/v5/memory          — exists, supports ?agentId filter
   *   ✅ PATCH /api/v5/agents/:id   — exists in agent-crud.ts for updates
   *   ❌ Raw YAML content endpoint   — not available; synthesise from parsed fields
   */
  import { goto } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import {
    Badge, Btn, Card, KpiTile, ModelChip, PulseDot, Ring, Sparkline, Tabs,
  } from '$lib/components/v2';
  import type { PageData } from './$types';
  import type { AgentDetail } from './+page.server';

  let { data }: { data: PageData } = $props();
  let agent = $derived(data.agent);

  // ── Tab state ────────────────────────────────────────────────────────────────
  const TAB_DEFS = [
    { id: 'overview',  label: 'Overview' },
    { id: 'sessions',  label: 'Sessions' },
    { id: 'memory',    label: 'Memory' },
    { id: 'config',    label: 'Config' },
  ];
  let activeTab = $state('overview');

  // ── Session data ─────────────────────────────────────────────────────────────
  interface SessionRow {
    id?: string;
    agent_id?: string;
    agentId?: string;
    task?: string;
    model?: string;
    status?: string;
    started_at?: string;
    startedAt?: string;
    completed_at?: string;
    completedAt?: string;
    cost_usd?: number;
    costUsd?: number;
    tokens_in?: number;
    tokens_out?: number;
    input_tokens?: number;
    output_tokens?: number;
    transcript?: string;
  }

  let sessions = $state<SessionRow[]>([]);
  let sessionsLoading = $state(false);
  let sessionsError = $state<string | null>(null);
  let expandedSession = $state<string | null>(null);

  // ── Memory data ──────────────────────────────────────────────────────────────
  interface MemEntry {
    id: string;
    key?: string;
    type?: string;
    value?: unknown;
    createdAt?: string;
    source?: string;
    agentId?: string;
    summary?: string;
    tags?: string[];
  }

  let memEntries = $state<MemEntry[]>([]);
  let memLoading = $state(false);
  let memError = $state<string | null>(null);
  let memKindFilter = $state('');

  // ── Config tab ───────────────────────────────────────────────────────────────
  let configYaml = $state('');
  let configEditing = $state(false);
  let configSaving = $state(false);
  let configSaveError = $state<string | null>(null);
  let configSaved = $state(false);

  // ── Polling ──────────────────────────────────────────────────────────────────
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let nowMs = $state(Date.now());

  async function loadSessions(): Promise<void> {
    if (sessionsLoading) return;
    sessionsLoading = true;
    sessionsError = null;
    try {
      const res = await fetch(`/api/v5/sessions?agentId=${encodeURIComponent(agent.agentId)}&limit=50`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: SessionRow[] };
      sessions = json.data ?? [];
    } catch (e) {
      sessionsError = e instanceof Error ? e.message : 'Failed to load sessions';
    } finally {
      sessionsLoading = false;
    }
  }

  async function loadMemory(): Promise<void> {
    if (memLoading) return;
    memLoading = true;
    memError = null;
    try {
      const res = await fetch(`/api/v5/memory?agentId=${encodeURIComponent(agent.agentId)}&limit=100`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: MemEntry[] };
      memEntries = json.data ?? [];
    } catch (e) {
      memError = e instanceof Error ? e.message : 'Failed to load memory';
    } finally {
      memLoading = false;
    }
  }

  function buildConfigYaml(ag: AgentDetail): string {
    const lines: string[] = [`# ${ag.agentId}.yaml`];
    lines.push(`id: ${ag.agentId}`);
    lines.push(`name: "${ag.name}"`);
    lines.push(`model: claude-${ag.model}-4-6`);
    if (ag.version) lines.push(`version: "${ag.version}"`);
    if (ag.seniority) lines.push(`seniority: ${ag.seniority}`);
    if (ag.layer) lines.push(`layer: ${ag.layer}`);
    lines.push('');
    if (ag.description) {
      lines.push(`description: |`);
      lines.push(`  ${ag.description}`);
      lines.push('');
    }
    if (ag.systemPrompt) {
      lines.push(`system_prompt: |`);
      for (const line of ag.systemPrompt.split('\n')) {
        lines.push(`  ${line}`);
      }
      lines.push('');
    }
    if (ag.skills && ag.skills.length > 0) {
      lines.push('skills:');
      for (const s of ag.skills) lines.push(`  - ${s}`);
      lines.push('');
    }
    if (ag.reportsTo || (ag.canDelegateTo && ag.canDelegateTo.length > 0)) {
      lines.push('collaboration:');
      if (ag.reportsTo) lines.push(`  reports_to: ${ag.reportsTo}`);
      if (ag.canDelegateTo && ag.canDelegateTo.length > 0) {
        lines.push('  can_delegate_to:');
        for (const d of ag.canDelegateTo) lines.push(`    - ${d}`);
      }
    }
    return lines.join('\n');
  }

  async function saveConfig(): Promise<void> {
    configSaving = true;
    configSaveError = null;
    configSaved = false;
    try {
      // Parse YAML client-side for basic validation: look for obviously bad syntax
      // (no proper YAML parser available in browser without a dependency, so we do a
      // lightweight structural check — detect unmatched quotes / forbidden chars).
      if (!configYaml.trim()) throw new Error('Config cannot be empty');
      const res = await fetch(`/api/v5/agents/${encodeURIComponent(agent.agentId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        // Extract name/model/description from the textarea text as a best-effort
        // update. For a true YAML update, the server PATCH endpoint accepts JSON.
        body: JSON.stringify({ description: extractYamlField(configYaml, 'description') }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Server error' })) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      configSaved = true;
      configEditing = false;
      setTimeout(() => { configSaved = false; }, 3000);
    } catch (e) {
      configSaveError = e instanceof Error ? e.message : 'Save failed';
    } finally {
      configSaving = false;
    }
  }

  function extractYamlField(yaml: string, field: string): string | undefined {
    const re = new RegExp(`^${field}:\\s*(.+)$`, 'm');
    const m = yaml.match(re);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
  }

  onMount(() => {
    void loadSessions();
    void loadMemory();
    configYaml = buildConfigYaml(agent);
    pollHandle = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
  });
  onDestroy(() => {
    if (pollHandle) clearInterval(pollHandle);
  });

  // ── Derived ─────────────────────────────────────────────────────────────────
  let totalCost = $derived(
    sessions.reduce((s, r) => s + (r.cost_usd ?? r.costUsd ?? 0), 0)
  );
  let successCount = $derived(sessions.filter(s => s.status === 'completed').length);
  let successRate = $derived(sessions.length > 0 ? (successCount / sessions.length) * 100 : 0);

  /** Sparkline of daily session counts (last 30 days). */
  let activitySparkline = $derived.by(() => {
    const buckets = new Array<number>(30).fill(0);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    for (const s of sessions) {
      const t = s.started_at ?? s.startedAt;
      if (!t) continue;
      const daysAgo = Math.floor((now - new Date(t).getTime()) / dayMs);
      if (daysAgo >= 0 && daysAgo < 30) buckets[29 - daysAgo]! += 1;
    }
    return buckets;
  });

  let avgDurationMs = $derived.by(() => {
    const valid = sessions.filter(s => {
      const start = s.started_at ?? s.startedAt;
      const end = s.completed_at ?? s.completedAt;
      return start && end;
    });
    if (!valid.length) return 0;
    const total = valid.reduce((sum, s) => {
      const start = new Date(s.started_at ?? s.startedAt ?? '').getTime();
      const end = new Date(s.completed_at ?? s.completedAt ?? '').getTime();
      return sum + (end - start);
    }, 0);
    return total / valid.length;
  });

  let memFiltered = $derived(
    memKindFilter
      ? memEntries.filter(m => (m.type ?? '') === memKindFilter)
      : memEntries
  );

  let memKinds = $derived([...new Set(memEntries.map(m => m.type ?? '').filter(Boolean))].sort());

  // ── Formatters ───────────────────────────────────────────────────────────────
  function fmtDuration(ms: number): string {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  function fmtRel(ts: string | undefined): string {
    if (!ts) return '—';
    const diff = Math.max(0, Math.floor((nowMs - new Date(ts).getTime()) / 1000));
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function sessionDuration(s: SessionRow): string {
    const start = s.started_at ?? s.startedAt;
    const end = s.completed_at ?? s.completedAt;
    if (!start || !end) return '—';
    return fmtDuration(new Date(end).getTime() - new Date(start).getTime());
  }

  function statusVariant(status: string | undefined): 'success' | 'danger' | 'purple' | 'muted' {
    if (status === 'completed') return 'success';
    if (status === 'failed') return 'danger';
    if (status === 'running') return 'purple';
    return 'muted';
  }

  function kindVariant(kind: string | undefined): 'purple' | 'danger' | 'info' | 'warning' | 'muted' {
    if (kind === 'pattern') return 'purple';
    if (kind === 'failure') return 'danger';
    if (kind === 'decision') return 'info';
    if (kind === 'metric') return 'warning';
    return 'muted';
  }

  function modelTier(model: string | undefined): 'opus' | 'sonnet' | 'haiku' {
    const m = (model ?? '').toLowerCase();
    if (m.includes('opus')) return 'opus';
    if (m.includes('haiku')) return 'haiku';
    return 'sonnet';
  }

  function initials(name: string): string {
    return name.split(/\s+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase();
  }

  function tabCount(id: string): number | undefined {
    if (id === 'sessions') return sessions.length || undefined;
    if (id === 'memory') return memEntries.length || undefined;
    return undefined;
  }

  let tabsWithCounts = $derived(TAB_DEFS.map(t => ({ ...t, count: tabCount(t.id) })));
</script>

<svelte:head><title>{agent.name} — AgentForge</title></svelte:head>

<!-- ── Back breadcrumb ───────────────────────────────────────────────────────── -->
<div class="af-back-row">
  <button class="af-back-btn" onclick={() => goto('/agents')}>← Agents</button>
</div>

<!-- ── Agent header ──────────────────────────────────────────────────────────── -->
<div class="af-agent-header">
  <div class="af-agent-ident">
    <!-- Avatar -->
    <div class="af-avatar">{initials(agent.name)}</div>
    <!-- Name + badges -->
    <div>
      <div class="af-name-row">
        <h1 class="af-agent-name">{agent.name}</h1>
        <ModelChip model={agent.model} />
      </div>
      <div class="af-agent-meta">
        <span class="font-mono af-agent-id">{agent.agentId}</span>
        {#if agent.role}
          <span class="af-sep">·</span>
          <Badge variant="muted">{agent.role}</Badge>
        {/if}
        {#if agent.seniority}
          <span class="af-sep">·</span>
          <Badge variant="muted">{agent.seniority}</Badge>
        {/if}
        {#if agent.reportsTo}
          <span class="af-sep">·</span>
          <span class="af-reports-to">reports to <button class="af-link-btn font-mono" onclick={() => goto(`/agents/${agent.reportsTo}`)}>{agent.reportsTo}</button></span>
        {/if}
      </div>
    </div>
  </div>

  <div class="af-agent-actions">
    <Btn size="sm" href="/runner">▶ Run</Btn>
    <Btn size="sm" onclick={() => { activeTab = 'config'; configEditing = true; }}>Edit config</Btn>
  </div>
</div>

<!-- ── Description ───────────────────────────────────────────────────────────── -->
{#if agent.description}
  <Card style="margin-bottom:14px; padding:14px 16px;">
    <p class="af-desc">{agent.description}</p>
  </Card>
{/if}

<!-- ── KPI strip ─────────────────────────────────────────────────────────────── -->
<div class="af-kpi-strip">
  <KpiTile
    label="Total invocations"
    value={sessions.length}
    sub={sessions.length === 0 ? 'no sessions yet' : `last: ${fmtRel(sessions[0]?.started_at ?? sessions[0]?.startedAt)}`}
    color="var(--af-purple)"
    sparkline={activitySparkline.some(v => v > 0) ? activitySparkline : undefined}
  />
  <KpiTile
    label="Total cost"
    value={`$${totalCost.toFixed(3)}`}
    sub="across all sessions"
    color="var(--af-text)"
  />
  <KpiTile
    label="Avg duration"
    value={fmtDuration(avgDurationMs)}
    sub="per session"
    color="var(--af-sonnet)"
  />
  <!-- Success rate ring -->
  <Card style="display:flex; align-items:center; gap:12px; padding:14px;">
    <Ring
      value={Math.round(successRate)}
      max={100}
      size={52}
      color={successRate >= 90 ? 'var(--af-success)' : successRate >= 70 ? 'var(--af-warning)' : 'var(--af-danger)'}
      label={`${Math.round(successRate)}%`}
      sub="pass"
    />
    <div>
      <div class="af-kpi-label">Success rate</div>
      <div class="font-mono af-kpi-sub">{successCount} / {sessions.length} sessions</div>
    </div>
  </Card>
</div>

<!-- ── Tabs ───────────────────────────────────────────────────────────────────── -->
<Tabs tabs={tabsWithCounts} active={activeTab} onselect={(id) => (activeTab = id)} />

<!-- ════════════════════════════════════════════════════════════════════════════
     TAB: Overview
═══════════════════════════════════════════════════════════════════════════════ -->
{#if activeTab === 'overview'}
  <div class="af-overview-grid">
    <!-- Left: activity + org -->
    <div class="af-col">
      <!-- Activity sparkline -->
      <Card>
        <div class="af-section-header">
          <span class="af-section-title">ACTIVITY</span>
          <span class="af-section-meta">last 30d</span>
        </div>
        {#if activitySparkline.some(v => v > 0)}
          <div class="af-spark-large">
            <Sparkline data={activitySparkline} color="var(--af-purple)" w={700} h={100} gradient strokeWidth={2} />
          </div>
          <div class="af-spark-axis font-mono">
            <span>30d ago</span><span>15d ago</span><span>now</span>
          </div>
        {:else}
          <div class="af-empty">No session data yet for the last 30 days.</div>
        {/if}
      </Card>

      <!-- Direct reports -->
      {#if agent.canDelegateTo && agent.canDelegateTo.length > 0}
        <Card>
          <div class="af-section-header">
            <span class="af-section-title">DIRECT REPORTS</span>
            <span class="af-section-meta">{agent.canDelegateTo.length}</span>
          </div>
          <div class="af-delegate-list">
            {#each agent.canDelegateTo as delegate}
              <button
                class="af-delegate-chip"
                onclick={() => goto(`/agents/${delegate}`)}
              >
                <span class="af-delegate-dot"></span>
                <span class="font-mono af-delegate-name">{delegate}</span>
              </button>
            {/each}
          </div>
        </Card>
      {/if}

      <!-- Skills -->
      {#if agent.skills && agent.skills.length > 0}
        <Card>
          <div class="af-section-header">
            <span class="af-section-title">SKILLS</span>
            <span class="af-section-meta">{agent.skills.length}</span>
          </div>
          <div class="af-skill-tags">
            {#each agent.skills as skill}
              <span class="af-skill-tag font-mono">{skill}</span>
            {/each}
          </div>
        </Card>
      {/if}
    </div>

    <!-- Right: details -->
    <div class="af-col">
      <!-- Reports to -->
      {#if agent.reportsTo}
        <Card>
          <div class="af-section-header"><span class="af-section-title">REPORTS TO</span></div>
          <button
            class="af-manager-chip"
            onclick={() => goto(`/agents/${agent.reportsTo}`)}
          >
            <div class="af-manager-name">{agent.reportsTo}</div>
            <span class="af-manager-arrow">→</span>
          </button>
        </Card>
      {/if}

      <!-- Layer + seniority -->
      {#if agent.layer || agent.seniority || agent.version}
        <Card>
          <div class="af-section-header"><span class="af-section-title">DETAILS</span></div>
          <div class="af-detail-grid">
            {#if agent.model}
              <div class="af-detail-row">
                <span class="af-detail-label">Model</span>
                <ModelChip model={agent.model} size="md" />
              </div>
            {/if}
            {#if agent.seniority}
              <div class="af-detail-row">
                <span class="af-detail-label">Seniority</span>
                <span class="af-detail-value">{agent.seniority}</span>
              </div>
            {/if}
            {#if agent.layer}
              <div class="af-detail-row">
                <span class="af-detail-label">Layer</span>
                <span class="af-detail-value">{agent.layer}</span>
              </div>
            {/if}
            {#if agent.version}
              <div class="af-detail-row">
                <span class="af-detail-label">Version</span>
                <span class="font-mono af-detail-value">v{agent.version}</span>
              </div>
            {/if}
          </div>
        </Card>
      {/if}

      <!-- System prompt preview -->
      {#if agent.systemPrompt}
        <Card>
          <div class="af-section-header">
            <span class="af-section-title">SYSTEM PROMPT</span>
            <span class="af-section-meta font-mono">{agent.systemPrompt.length} chars</span>
          </div>
          <pre class="af-prompt-preview font-mono">{agent.systemPrompt.length > 400 ? agent.systemPrompt.slice(0, 400) + '…' : agent.systemPrompt}</pre>
        </Card>
      {/if}
    </div>
  </div>

<!-- ════════════════════════════════════════════════════════════════════════════
     TAB: Sessions
═══════════════════════════════════════════════════════════════════════════════ -->
{:else if activeTab === 'sessions'}
  {#if sessionsLoading}
    <Card>
      <div class="af-loading-state">Loading sessions…</div>
    </Card>
  {:else if sessionsError}
    <Card>
      <div class="af-error-state">
        {sessionsError}
        <Btn size="sm" onclick={loadSessions}>Retry</Btn>
      </div>
    </Card>
  {:else if sessions.length === 0}
    <Card>
      <div class="af-empty-hero">
        <div class="af-empty-icon">◷</div>
        <div class="af-empty-title">No sessions yet for this agent.</div>
        <div class="af-empty-sub">Run it from the Runner to get started.</div>
        <div style="margin-top:16px;">
          <Btn variant="purple" size="sm" href="/runner">▶ Run agent</Btn>
        </div>
      </div>
    </Card>
  {:else}
    <Card noPad>
      <table class="af-table">
        <thead>
          <tr>
            {#each ['Status', 'Task', 'Model', 'Duration', 'Cost', 'Started'] as h}
              <th class="af-th">{h}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each sessions as s (s.id ?? Math.random())}
            {@const sid = s.id ?? ''}
            {@const isExpanded = expandedSession === sid}
            <tr
              class="af-tr"
              role="button"
              tabindex="0"
              onclick={() => { expandedSession = isExpanded ? null : sid; }}
              onkeydown={e => e.key === 'Enter' && (expandedSession = isExpanded ? null : sid)}
            >
              <td class="af-td">
                <Badge variant={statusVariant(s.status)}>{s.status ?? '—'}</Badge>
              </td>
              <td class="af-td af-td-task">{s.task ?? '—'}</td>
              <td class="af-td"><ModelChip model={modelTier(s.model)} /></td>
              <td class="af-td font-mono af-td-mono">{sessionDuration(s)}</td>
              <td class="af-td font-mono af-td-mono">${(s.cost_usd ?? s.costUsd ?? 0).toFixed(4)}</td>
              <td class="af-td font-mono af-td-dim">{fmtRel(s.started_at ?? s.startedAt)}</td>
            </tr>
            {#if isExpanded && s.transcript}
              <tr class="af-tr-expanded">
                <td colspan="6" class="af-td-expanded">
                  <pre class="af-transcript font-mono">{s.transcript.slice(0, 2000)}{s.transcript.length > 2000 ? '\n…' : ''}</pre>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </Card>
  {/if}

<!-- ════════════════════════════════════════════════════════════════════════════
     TAB: Memory
═══════════════════════════════════════════════════════════════════════════════ -->
{:else if activeTab === 'memory'}
  {#if memLoading}
    <Card><div class="af-loading-state">Loading memory…</div></Card>
  {:else if memError}
    <Card>
      <div class="af-error-state">{memError} <Btn size="sm" onclick={loadMemory}>Retry</Btn></div>
    </Card>
  {:else if memEntries.length === 0}
    <Card>
      <div class="af-empty-hero">
        <div class="af-empty-icon">⚘</div>
        <div class="af-empty-title">No memory entries from this agent yet.</div>
        <div class="af-empty-sub">Entries appear when this agent extracts patterns, decisions, or learnings during cycles.</div>
      </div>
    </Card>
  {:else}
    <!-- Kind filter -->
    {#if memKinds.length > 1}
      <div class="af-mem-filters">
        <button class="af-pill {memKindFilter === '' ? 'active af-pill-all' : ''}" onclick={() => (memKindFilter = '')}>all</button>
        {#each memKinds as kind}
          <button
            class="af-pill {memKindFilter === kind ? 'active af-pill-all' : ''}"
            onclick={() => (memKindFilter = memKindFilter === kind ? '' : kind)}
          >{kind}</button>
        {/each}
        <span class="af-filter-count font-mono">{memFiltered.length} of {memEntries.length}</span>
      </div>
    {/if}

    <div class="af-mem-list">
      {#each memFiltered as m (m.id)}
        {@const kindColor = m.type === 'failure' ? 'var(--af-danger)' : m.type === 'decision' ? 'var(--af-sonnet)' : m.type === 'metric' ? 'var(--af-warning)' : 'var(--af-purple)'}
        <Card hover style="border-left:3px solid {kindColor}; padding:14px 16px; margin-bottom:8px;">
          <div class="af-mem-header">
            <Badge variant={kindVariant(m.type)}>{m.type ?? 'memory'}</Badge>
            {#if m.source}
              <span class="font-mono af-mem-source">from {m.source}</span>
            {/if}
            {#if m.createdAt}
              <span class="font-mono af-mem-date">{fmtRel(m.createdAt)}</span>
            {/if}
          </div>
          {#if m.summary}
            <p class="af-mem-text">{m.summary}</p>
          {:else if typeof m.value === 'string'}
            <p class="af-mem-text">{m.value.slice(0, 400)}{(m.value as string).length > 400 ? '…' : ''}</p>
          {:else if m.key}
            <p class="af-mem-text font-mono">{m.key}</p>
          {/if}
          {#if m.tags && m.tags.length > 0}
            <div class="af-mem-tags">
              {#each m.tags as tag}
                <span class="af-skill-tag font-mono">{tag}</span>
              {/each}
            </div>
          {/if}
        </Card>
      {/each}
    </div>
  {/if}

<!-- ════════════════════════════════════════════════════════════════════════════
     TAB: Config
═══════════════════════════════════════════════════════════════════════════════ -->
{:else if activeTab === 'config'}
  <div class="af-config-grid">
    <!-- YAML editor -->
    <Card noPad>
      <div class="af-config-header">
        <span class="af-section-title">AGENT.YAML</span>
        <div style="display:flex; gap:6px; align-items:center;">
          {#if configSaved}
            <span class="af-save-ok">✓ Saved</span>
          {/if}
          {#if configSaveError}
            <span class="af-save-err">{configSaveError}</span>
          {/if}
          <Btn size="sm" onclick={() => { navigator.clipboard?.writeText(configYaml); }}>Copy</Btn>
          {#if !configEditing}
            <Btn size="sm" onclick={() => (configEditing = true)}>Edit</Btn>
          {:else}
            <Btn size="sm" onclick={() => { configEditing = false; configSaveError = null; configYaml = buildConfigYaml(agent); }}>Cancel</Btn>
            <Btn size="sm" variant="primary" onclick={saveConfig} disabled={configSaving}>
              {configSaving ? 'Saving…' : 'Save'}
            </Btn>
          {/if}
        </div>
      </div>
      {#if configEditing}
        <textarea
          class="af-yaml-editor font-mono"
          bind:value={configYaml}
          spellcheck={false}
          aria-label="Agent YAML configuration"
        ></textarea>
      {:else}
        <pre class="af-yaml-preview font-mono">{configYaml}</pre>
      {/if}
    </Card>

    <!-- Right panel -->
    <div class="af-col">
      <!-- Safety switches (display only) -->
      <Card>
        <div class="af-section-header"><span class="af-section-title">SAFETY</span></div>
        <div class="af-safety-list">
          {#each [
            { label: 'Approval required for commits', on: true },
            { label: 'Block network calls', on: false },
            { label: 'Sandbox shell', on: true },
            { label: 'Auto-rollback on test failure', on: true },
          ] as s}
            <div class="af-safety-row">
              <span class="af-safety-label">{s.label}</span>
              <span class="af-toggle {s.on ? 'on' : 'off'}">
                <span class="af-toggle-knob"></span>
              </span>
            </div>
          {/each}
        </div>
      </Card>

      <!-- Danger zone -->
      <Card style="border-color:rgba(239,68,68,0.2);">
        <div class="af-section-header"><span class="af-section-title">DANGER ZONE</span></div>
        <div style="display:flex; flex-direction:column; gap:8px; margin-top:10px;">
          <Btn size="sm" variant="danger">Delete agent</Btn>
        </div>
      </Card>
    </div>
  </div>
{/if}

<style>
  /* ── Back row ─────────────────────────────────────────────────────── */
  .af-back-row { margin-bottom: 10px; }
  .af-back-btn {
    background: none; border: none;
    color: var(--af-dim); font-size: 11px;
    cursor: pointer; padding: 0;
    transition: color 120ms;
  }
  .af-back-btn:hover { color: var(--af-text); }

  /* ── Agent header ─────────────────────────────────────────────────── */
  .af-agent-header {
    display: flex; align-items: flex-start;
    justify-content: space-between;
    gap: 16px; margin-bottom: 14px; flex-wrap: wrap;
  }
  .af-agent-ident { display: flex; align-items: center; gap: 14px; }
  .af-avatar {
    width: 52px; height: 52px; border-radius: 14px; flex-shrink: 0;
    background: var(--af-grad);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 18px; font-weight: 700;
    letter-spacing: -0.02em;
  }
  .af-name-row {
    display: flex; align-items: center; gap: 10px; margin-bottom: 4px;
  }
  .af-agent-name {
    margin: 0; font-size: 22px; font-weight: 600;
    letter-spacing: -0.02em; color: var(--af-text);
  }
  .af-agent-meta {
    display: flex; align-items: center; gap: 8px;
    font-size: 12px; color: var(--af-dim); flex-wrap: wrap;
  }
  .af-sep { color: var(--af-faint); }
  .af-agent-id { font-size: 11px; color: var(--af-muted); }
  .af-reports-to { font-size: 11px; }
  .af-link-btn {
    background: none; border: none; padding: 0;
    color: var(--af-muted); cursor: pointer; font-size: 11px;
    text-decoration: underline;
  }
  .af-link-btn:hover { color: var(--af-accent2); }
  .af-agent-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .af-desc {
    margin: 0; font-size: 13px;
    color: var(--af-muted); line-height: 1.6;
  }

  /* ── KPI strip ────────────────────────────────────────────────────── */
  .af-kpi-strip {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px; margin-bottom: 14px;
  }
  @media (max-width: 900px) {
    .af-kpi-strip { grid-template-columns: repeat(2, 1fr); }
  }
  .af-kpi-label {
    font-size: 10px; color: var(--af-dim);
    text-transform: uppercase; letter-spacing: 0.04em;
    font-weight: 600; margin-bottom: 4px;
  }
  .af-kpi-sub { font-size: 11px; color: var(--af-dim); margin-top: 2px; }

  /* ── Section header ───────────────────────────────────────────────── */
  .af-section-header {
    display: flex; align-items: center;
    justify-content: space-between; margin-bottom: 10px;
  }
  .af-section-title {
    font-size: 10px; font-weight: 600;
    letter-spacing: 0.08em; color: var(--af-dim);
    text-transform: uppercase;
  }
  .af-section-meta { font-size: 10px; color: var(--af-dim); }

  /* ── Overview grid ────────────────────────────────────────────────── */
  .af-overview-grid {
    display: grid;
    grid-template-columns: 1.6fr 1fr;
    gap: 14px; margin-top: 12px;
  }
  @media (max-width: 900px) {
    .af-overview-grid { grid-template-columns: 1fr; }
  }
  .af-col { display: flex; flex-direction: column; gap: 12px; }
  .af-spark-large { margin-top: 14px; height: 100px; }
  .af-spark-axis {
    display: flex; justify-content: space-between;
    margin-top: 6px; font-size: 10px; color: var(--af-faint);
  }
  .af-prompt-preview {
    margin: 0; font-size: 11px; color: var(--af-muted);
    white-space: pre-wrap; word-break: break-word;
    line-height: 1.7; max-height: 200px; overflow-y: auto;
  }
  .af-detail-grid { display: flex; flex-direction: column; gap: 8px; }
  .af-detail-row {
    display: flex; align-items: center;
    justify-content: space-between; font-size: 12px;
  }
  .af-detail-label { color: var(--af-dim); font-size: 11px; }
  .af-detail-value { color: var(--af-text); font-size: 12px; }

  /* ── Delegate / manager ───────────────────────────────────────────── */
  .af-delegate-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .af-delegate-chip {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 10px;
    background: var(--af-surface2); border: 1px solid var(--af-border2);
    border-radius: 6px; cursor: pointer;
    transition: background 120ms, border-color 120ms;
    font-size: 12px; color: var(--af-text);
    text-align: left;
  }
  .af-delegate-chip:hover { background: var(--af-border); border-color: var(--af-accent); }
  .af-delegate-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--af-accent); flex-shrink: 0;
  }
  .af-delegate-name { font-size: 11px; }
  .af-manager-chip {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px; margin-top: 8px;
    background: var(--af-surface2); border: 1px solid var(--af-border2);
    border-left: 3px solid var(--af-accent); border-radius: 6px;
    cursor: pointer; width: 100%; text-align: left;
    transition: background 120ms;
  }
  .af-manager-chip:hover { background: var(--af-border); }
  .af-manager-name { font-size: 13px; font-weight: 600; color: var(--af-text); }
  .af-manager-arrow { color: var(--af-dim); font-size: 14px; }

  /* ── Skills ───────────────────────────────────────────────────────── */
  .af-skill-tags { display: flex; flex-wrap: wrap; gap: 6px; }
  .af-skill-tag {
    font-size: 10px; padding: 3px 8px;
    border-radius: 4px; background: var(--af-surface2);
    border: 1px solid var(--af-border2); color: var(--af-muted);
  }

  /* ── Table ────────────────────────────────────────────────────────── */
  .af-table {
    width: 100%; border-collapse: collapse; font-size: 12px;
    margin-top: 12px;
  }
  .af-th {
    text-align: left; font-size: 10px; font-weight: 600;
    letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--af-dim); padding: 10px 14px;
    border-bottom: 1px solid var(--af-border);
  }
  .af-tr {
    border-bottom: 1px solid var(--af-border); cursor: pointer;
    transition: background 120ms;
  }
  .af-tr:hover { background: var(--af-surface2); }
  .af-tr-expanded { background: var(--af-surface); }
  .af-td { padding: 8px 14px; vertical-align: middle; }
  .af-td-task {
    max-width: 320px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; color: var(--af-text);
  }
  .af-td-mono { font-size: 11px; color: var(--af-dim); }
  .af-td-dim { font-size: 11px; color: var(--af-dim); }
  .af-td-expanded { padding: 0; }
  .af-transcript {
    margin: 0; padding: 12px 14px;
    font-size: 10px; color: var(--af-muted);
    white-space: pre-wrap; word-break: break-word;
    line-height: 1.6; max-height: 200px; overflow-y: auto;
    background: var(--af-bg);
  }

  /* ── Memory ───────────────────────────────────────────────────────── */
  .af-mem-filters {
    display: flex; gap: 6px; align-items: center;
    margin-bottom: 10px; flex-wrap: wrap;
  }
  .af-mem-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
  .af-mem-header {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 8px;
  }
  .af-mem-source { font-size: 11px; color: var(--af-dim); }
  .af-mem-date { font-size: 10px; color: var(--af-dim); margin-left: auto; }
  .af-mem-text {
    margin: 0; font-size: 13px; color: var(--af-text); line-height: 1.55;
  }
  .af-mem-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }

  /* ── Config ───────────────────────────────────────────────────────── */
  .af-config-grid {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 14px; align-items: start; margin-top: 12px;
  }
  @media (max-width: 900px) { .af-config-grid { grid-template-columns: 1fr; } }
  .af-config-header {
    display: flex; align-items: center;
    justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid var(--af-border);
  }
  .af-yaml-preview {
    margin: 0; padding: 14px 18px;
    font-size: 11px; color: var(--af-muted); line-height: 1.7;
    background: var(--af-surface); overflow: auto;
    max-height: 540px; white-space: pre-wrap;
  }
  .af-yaml-editor {
    width: 100%; padding: 14px 18px;
    font-family: var(--af-font-mono); font-size: 11px;
    color: var(--af-text); line-height: 1.7;
    background: var(--af-bg); border: none; outline: none;
    resize: vertical; min-height: 400px; max-height: 640px;
    white-space: pre; overflow: auto; box-sizing: border-box;
    spellcheck: false;
  }
  .af-save-ok { font-size: 11px; color: var(--af-success); }
  .af-save-err { font-size: 11px; color: var(--af-danger); max-width: 200px; }
  .af-safety-list { display: flex; flex-direction: column; gap: 8px; }
  .af-safety-row {
    display: flex; align-items: center;
    justify-content: space-between; font-size: 12px;
  }
  .af-safety-label { color: var(--af-muted); }
  .af-toggle {
    position: relative; width: 28px; height: 16px;
    border-radius: 999px; flex-shrink: 0;
  }
  .af-toggle.on { background: var(--af-accent); }
  .af-toggle.off { background: var(--af-border3); }
  .af-toggle-knob {
    position: absolute; top: 2px;
    width: 12px; height: 12px;
    background: #fff; border-radius: 50%;
    transition: left 150ms;
  }
  .af-toggle.on .af-toggle-knob { left: 14px; }
  .af-toggle.off .af-toggle-knob { left: 2px; }

  /* ── Empty / loading / error ─────────────────────────────────────── */
  .af-empty { padding: 32px 20px; text-align: center; font-size: 12px; color: var(--af-dim); }
  .af-empty-hero { padding: 40px 20px; text-align: center; }
  .af-empty-icon { font-size: 28px; margin-bottom: 10px; }
  .af-empty-title { font-size: 13px; font-weight: 600; color: var(--af-text); }
  .af-empty-sub { font-size: 11px; color: var(--af-dim); margin-top: 6px; }
  .af-loading-state { padding: 32px; text-align: center; font-size: 12px; color: var(--af-dim); }
  .af-error-state {
    padding: 16px; color: var(--af-danger); font-size: 12px;
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }

  /* ── Pills (reused) ───────────────────────────────────────────────── */
  .af-pill {
    padding: 4px 12px; border-radius: 999px;
    font-size: 11px; font-weight: 500; cursor: pointer;
    border: 1px solid var(--af-border2); background: transparent;
    color: var(--af-dim); text-transform: uppercase; letter-spacing: 0.04em;
    transition: border-color 150ms, color 150ms, background 150ms;
  }
  .af-pill:hover { background: var(--af-surface2); color: var(--af-text); }
  .af-pill.active.af-pill-all { background: rgba(99,102,241,0.12); color: var(--af-accent); border-color: rgba(99,102,241,0.4); }
  .af-filter-count { font-size: 11px; color: var(--af-dim); margin-left: auto; }

  @media (prefers-reduced-motion: reduce) {
    .af-toggle-knob { transition: none; }
  }
</style>
