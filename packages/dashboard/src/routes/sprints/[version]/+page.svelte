<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import ProgressBar from '$lib/components/ProgressBar.svelte';
  import Gauge from '$lib/components/Gauge.svelte';

  interface SprintItem {
    id: string;
    title: string;
    description?: string;
    priority: 'P0' | 'P1' | 'P2';
    assignee?: string;
    status: 'completed' | 'in_progress' | 'pending' | 'blocked' | 'failed';
    estimatedCost?: number;
    tags?: string[];
    source?: string;
  }

  interface VersionDecision {
    previousVersion?: string;
    nextVersion?: string;
    tier?: string;
    rationale?: string;
    tagsSeen?: string[];
  }

  interface SprintDetail {
    id: string;
    version: string;
    sprintId?: string;
    title?: string;
    phase?: string;
    status: 'completed' | 'in_progress' | 'pending';
    startDate?: string;
    endDate?: string;
    budget?: number;
    teamSize?: number;
    successCriteria?: string[];
    auditFindings?: string[];
    testCountBefore?: number;
    testCountAfter?: number;
    testCountDelta?: number;
    totalCostUsd?: number;
    autonomous?: boolean;
    theme?: string;
    versionDecision?: VersionDecision;
    items: SprintItem[];
  }

  let sprint: SprintDetail | null = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);

  const version = $derived(page.params.version ?? '');

  async function load(ver: string) {
    loading = true;
    error = null;
    try {
      const res = await fetch(`/api/v5/sprints/${ver}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      sprint = json.data ?? json;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    if (version) load(version);
  });

  // Svelte 5's $derived has a type inference limitation: state variables
  // initialised with `null` are narrowed to `never` inside the rune's scope
  // when accessed via property access. The workaround is to read items through
  // a helper that carries the explicit generic, keeping the cast isolated here.
  function sprintItems(s: SprintDetail | null): SprintItem[] {
    return s?.items ?? [];
  }
  let allItems = $derived(sprintItems(sprint));
  let completedCount = $derived(allItems.filter((i: SprintItem) => i.status === 'completed').length);
  let totalCount = $derived(allItems.length);
  let pct = $derived(totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0);
  let p0Items = $derived(allItems.filter((i: SprintItem) => i.priority === 'P0'));
  let p1Items = $derived(allItems.filter((i: SprintItem) => i.priority === 'P1'));
  let p2Items = $derived(allItems.filter((i: SprintItem) => i.priority === 'P2'));

  // Kanban columns
  let plannedItems = $derived(allItems.filter((i: SprintItem) => i.status === 'pending'));
  let inProgressItems = $derived(allItems.filter((i: SprintItem) => i.status === 'in_progress'));
  let completedItems = $derived(allItems.filter((i: SprintItem) => i.status === 'completed'));
  let blockedItems = $derived(allItems.filter((i: SprintItem) => i.status === 'blocked'));
  let failedItems = $derived(allItems.filter((i: SprintItem) => i.status === 'failed'));

  let expandedItemId: string | null = $state(null);
  function toggleExpand(id: string) {
    expandedItemId = expandedItemId === id ? null : id;
  }
  function truncate(s: string, n = 60): string {
    return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
  }
  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function humanDuration(startIso: string, endIso: string): string {
    const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
    if (ms <= 0) return '';
    const totalMins = Math.round(ms / 60000);
    if (totalMins < 60) return `${totalMins}m`;
    const hours = ms / (1000 * 60 * 60);
    if (hours < 24) return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
    const days = hours / 24;
    return `${Number.isInteger(days) ? days : days.toFixed(1)}d`;
  }
  let durationStr = $derived.by(() => {
    const s = sprint;
    if (!s?.startDate || !s?.endDate) return null;
    return humanDuration(s.startDate, s.endDate);
  });

  const STATUS_LABEL: Record<string, string> = {
    completed: 'Completed',
    in_progress: 'In Progress',
    pending: 'Planned',
    blocked: 'Blocked',
    failed: 'Failed',
  };

  const STATUS_BADGE: Record<string, string> = {
    completed: 'success',
    in_progress: 'sonnet',
    pending: 'muted',
    blocked: 'danger',
    failed: 'danger',
  };

  const PHASE_LABEL: Record<string, string> = {
    planned: 'Planned',
    active: 'Active',
    executing: 'Executing',
    completed: 'Completed',
    done: 'Done',
    draft: 'Draft',
  };

  const ITEM_STATUS_COLOR: Record<string, string> = {
    completed: '#22c55e',
    in_progress: '#5b8af5',
    pending: '#64748b',
    blocked: '#e05a5a',
    failed: '#e05a5a',
  };

  // Column accent colors for the kanban headers
  const KANBAN_COL_COLOR: Record<string, string> = {
    planned: 'var(--color-text-faint)',
    in_progress: 'var(--color-brand)',
    completed: 'var(--color-success)',
    blocked: 'var(--color-danger)',
    failed: 'var(--color-danger)',
  };
</script>

<svelte:head>
  <title>{sprint?.title ?? `Sprint v${version}`} — AgentForge</title>
</svelte:head>

<div class="page-header">
  <div>
    <a href="/sprints" class="back-link">&larr; All Sprints</a>
    {#if sprint}
      <h1 class="page-title">v{sprint.version}</h1>
      {#if sprint.title}
        <p class="page-subtitle">{sprint.title}</p>
      {/if}
      {#if sprint.theme}
        <p class="page-theme">✦ {sprint.theme}</p>
      {/if}
      {#if sprint.sprintId}
        <p class="page-sprintid">{sprint.sprintId}</p>
      {/if}
    {:else}
      <h1 class="page-title">Sprint {version}</h1>
    {/if}
  </div>
  <div class="header-badges">
    {#if sprint}
      {#if sprint.autonomous}
        <span class="badge autonomous-badge">⚡ Autonomous</span>
      {/if}
      <span class="badge {STATUS_BADGE[sprint.status] ?? 'muted'}">{STATUS_LABEL[sprint.status] ?? sprint.status}</span>
      {#if sprint.phase && sprint.phase !== sprint.status}
        <span class="badge muted phase-badge">{PHASE_LABEL[sprint.phase] ?? sprint.phase}</span>
      {/if}
    {/if}
  </div>
</div>

{#if loading}
  <div class="card">
    <div class="skeleton" style="height:20px; width:50%; margin-bottom:var(--space-4);"></div>
    <div class="skeleton" style="height:14px; width:100%; margin-bottom:var(--space-2);"></div>
    <div class="skeleton" style="height:14px; width:80%;"></div>
  </div>
{:else if error}
  <div class="empty-state">
    Failed to load sprint.
    <button class="btn btn-ghost btn-sm" style="margin-top: var(--space-3)" onclick={() => load(version)}>Retry</button>
  </div>
{:else if !sprint}
  <div class="empty-state">Sprint <code>{version}</code> not found.</div>
{:else}
  <!-- Summary Row -->
  <div class="summary-row">
    <div class="summary-card highlight gauge-card">
      <Gauge
        value={pct}
        label="Complete"
        color={sprint.status === 'completed' ? 'var(--color-success)' : 'var(--color-brand)'}
      />
    </div>
    <div class="summary-card">
      <div class="summary-value">{completedCount}/{totalCount}</div>
      <div class="summary-label">Items Done</div>
    </div>
    {#if sprint.teamSize}
      <div class="summary-card">
        <div class="summary-value">{sprint.teamSize}</div>
        <div class="summary-label">Team Size</div>
      </div>
    {/if}
    {#if sprint.budget}
      <div class="summary-card">
        <div class="summary-value">${sprint.budget}</div>
        <div class="summary-label">Budget</div>
      </div>
    {/if}
    {#if sprint.totalCostUsd != null}
      <div class="summary-card">
        <div class="summary-value">${sprint.totalCostUsd.toFixed(2)}</div>
        <div class="summary-label">Actual Cost</div>
      </div>
    {/if}
    {#if sprint.testCountDelta != null}
      <div class="summary-card {sprint.testCountDelta > 0 ? 'highlight-success' : ''}">
        <div class="summary-value test-delta">{sprint.testCountDelta > 0 ? '+' : ''}{sprint.testCountDelta}</div>
        <div class="summary-label">Tests Added</div>
      </div>
    {/if}
    {#if sprint.testCountBefore != null && sprint.testCountAfter != null}
      <!-- Both counts: show progression pair for retrospective clarity -->
      <div class="summary-card">
        <div class="summary-value">{sprint.testCountBefore.toLocaleString()}</div>
        <div class="summary-label">Tests Before</div>
      </div>
      <div class="summary-card highlight-success">
        <div class="summary-value">{sprint.testCountAfter.toLocaleString()}</div>
        <div class="summary-label">Tests After</div>
      </div>
    {:else if sprint.testCountAfter != null}
      <div class="summary-card">
        <div class="summary-value">{sprint.testCountAfter.toLocaleString()}</div>
        <div class="summary-label">Total Tests</div>
      </div>
    {:else if sprint.testCountBefore != null}
      <div class="summary-card">
        <div class="summary-value">{sprint.testCountBefore.toLocaleString()}</div>
        <div class="summary-label">Tests Before</div>
      </div>
    {/if}
    {#if durationStr}
      <div class="summary-card">
        <div class="summary-value duration-value">{durationStr}</div>
        <div class="summary-label">Duration</div>
      </div>
    {/if}
    {#if sprint.startDate}
      <div class="summary-card">
        <div class="summary-value date-value">{formatDate(sprint.startDate ?? '')}</div>
        <div class="summary-label">Started</div>
      </div>
    {/if}
    {#if sprint.endDate}
      <div class="summary-card">
        <div class="summary-value date-value">{formatDate(sprint.endDate ?? '')}</div>
        <div class="summary-label">Ended</div>
      </div>
    {/if}
  </div>

  <!-- Progress Bar -->
  <div class="card" style="margin-bottom:var(--space-5);">
    <ProgressBar
      value={pct}
      label="Sprint Progress"
      color={sprint.status === 'completed' ? 'var(--color-success)' : 'var(--color-brand)'}
    />
  </div>

  <!-- Kanban Board -->
  <div class="section-heading">
    <span class="section-heading-label">Sprint Board</span>
    <span class="section-heading-count">{allItems.length} items</span>
  </div>
  <div class="kanban-board" class:has-failed={failedItems.length > 0}>
    {#each [
      { key: 'planned', label: 'Planned', items: plannedItems },
      { key: 'in_progress', label: 'In Progress', items: inProgressItems },
      { key: 'completed', label: 'Completed', items: completedItems },
      { key: 'blocked', label: 'Blocked', items: blockedItems },
      ...(failedItems.length > 0 ? [{ key: 'failed', label: 'Failed', items: failedItems }] : []),
    ] as col (col.key)}
      <div class="kanban-column">
        <div class="kanban-col-header" style="border-bottom-color: {KANBAN_COL_COLOR[col.key]};">
          <span class="kanban-col-title" style="color: {KANBAN_COL_COLOR[col.key]};">{col.label}</span>
          <span class="kanban-col-count">({col.items.length})</span>
        </div>
        <div class="kanban-col-body">
          {#if col.items.length === 0}
            <div class="kanban-empty">No items</div>
          {:else}
            {#each col.items as item (item.id)}
              <button
                type="button"
                class="kanban-card"
                onclick={() => toggleExpand(item.id)}
                title={item.title}
              >
                <div class="kanban-card-top">
                  <span class="priority-badge {item.priority === 'P0' ? 'danger' : item.priority === 'P1' ? 'warning' : 'muted'}">{item.priority}</span>
                  {#if item.estimatedCost != null}
                    <span class="kanban-cost">${item.estimatedCost.toFixed(2)}</span>
                  {/if}
                </div>
                <div class="kanban-card-title">{truncate(item.title)}</div>
                {#if item.assignee}
                  <div class="kanban-card-assignee">@{item.assignee}</div>
                {/if}
                {#if item.tags && item.tags.length > 0}
                  <div class="kanban-tags">
                    {#each item.tags as tag}
                      <span class="kanban-tag">{tag}</span>
                    {/each}
                  </div>
                {/if}
                {#if expandedItemId === item.id && item.description}
                  <div class="kanban-card-desc">{item.description}</div>
                {/if}
              </button>
            {/each}
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <!-- Items by Priority -->
  {#if p0Items.length > 0 || p1Items.length > 0 || p2Items.length > 0}
    <div class="section-heading">
      <span class="section-heading-label">Items by Priority</span>
    </div>
  {/if}
  {#each [
    { label: 'P0 — Critical', items: p0Items, cls: 'danger' },
    { label: 'P1 — Important', items: p1Items, cls: 'warning' },
    { label: 'P2 — Nice-to-Have', items: p2Items, cls: 'muted' },
  ] as group}
    {#if group.items.length > 0}
      <div class="card item-group" style="margin-bottom:var(--space-4);">
        <div class="group-header">
          <span class="priority-badge {group.cls}">{group.label}</span>
          <span class="group-count">
            {group.items.filter((i: SprintItem) => i.status === 'completed').length}/{group.items.length} done
          </span>
        </div>
        <div class="item-list">
          {#each group.items as item (item.id)}
            <div class="sprint-item {item.status}">
              <div class="item-dot" style="background: {ITEM_STATUS_COLOR[item.status] ?? '#64748b'}"></div>
              <div class="item-body">
                <div class="item-title">{item.title}</div>
                {#if item.description}
                  <div class="item-desc">{item.description}</div>
                {/if}
                <div class="item-meta">
                  {#if item.assignee}
                    <span class="item-assignee">@{item.assignee}</span>
                  {/if}
                  <span class="item-status-label status-{item.status}">{STATUS_LABEL[item.status] ?? item.status}</span>
                  {#if item.estimatedCost != null}
                    <span class="item-cost">${item.estimatedCost.toFixed(2)}</span>
                  {/if}
                  {#if item.source}
                    <span class="item-source">{item.source}</span>
                  {/if}
                </div>
                {#if item.tags && item.tags.length > 0}
                  <div class="item-tags">
                    {#each item.tags as tag}
                      <span class="item-tag">{tag}</span>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/each}

  <!-- Success Criteria — always rendered so the section is never silently absent -->
  <div class="section-heading">
    <span class="section-heading-label">Success Criteria</span>
    {#if sprint.successCriteria && sprint.successCriteria.length > 0}
      <span class="section-heading-count">{sprint.successCriteria.length}</span>
    {/if}
  </div>
  <div class="card criteria-card" style="margin-bottom:var(--space-4);">
    {#if sprint.successCriteria && sprint.successCriteria.length > 0}
      <ul class="criteria-list">
        {#each sprint.successCriteria as criterion, i}
          <li class="criterion">
            <span class="criterion-index">{String(i + 1).padStart(2, '0')}</span>
            <span class="criterion-text">{criterion}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <div class="section-empty">No success criteria defined for this sprint.</div>
    {/if}
  </div>

  <!-- Audit Findings — always rendered so the section is never silently absent -->
  <div class="section-heading">
    <span class="section-heading-label">Audit Findings</span>
    {#if sprint.auditFindings && sprint.auditFindings.length > 0}
      <span class="section-heading-count">{sprint.auditFindings.length}</span>
    {/if}
  </div>
  <div class="card findings-card" style="margin-bottom:var(--space-4);">
    {#if sprint.auditFindings && sprint.auditFindings.length > 0}
      <ul class="criteria-list findings">
        {#each sprint.auditFindings as finding, i}
          <li class="criterion finding">
            <span class="criterion-index">{String(i + 1).padStart(2, '0')}</span>
            <span class="criterion-text">{finding}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <div class="section-empty">No audit findings recorded for this sprint.</div>
    {/if}
  </div>

  <!-- Version Decision -->
  {#if sprint.versionDecision}
    {@const vd = sprint.versionDecision}
    <div class="section-heading">
      <span class="section-heading-label">Version Decision</span>
      {#if vd.tier}
        <span class="badge version-tier-badge version-tier-{vd.tier}">{vd.tier}</span>
      {/if}
    </div>
    <div class="card version-decision-card" style="margin-bottom:var(--space-4);">
      {#if vd.previousVersion || vd.nextVersion}
        <div class="version-bump-row">
          {#if vd.previousVersion}
            <span class="version-chip muted">v{vd.previousVersion}</span>
          {/if}
          <span class="version-arrow">→</span>
          {#if vd.nextVersion}
            <span class="version-chip highlight">v{vd.nextVersion}</span>
          {/if}
        </div>
      {/if}
      {#if vd.rationale}
        <p class="version-rationale">{vd.rationale}</p>
      {/if}
      {#if vd.tagsSeen && vd.tagsSeen.length > 0}
        <div class="version-tags-seen">
          <span class="version-tags-label">Tags seen</span>
          <div class="version-tags-row">
            {#each vd.tagsSeen as tag}
              <span class="version-tag-chip">{tag}</span>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Sprint Navigation -->
  {#if sprint.versionDecision?.previousVersion || sprint.versionDecision?.nextVersion}
    <div class="sprint-nav">
      {#if sprint.versionDecision?.previousVersion}
        <a href="/sprints/{sprint.versionDecision.previousVersion}" class="sprint-nav-link">
          &larr; v{sprint.versionDecision.previousVersion}
        </a>
      {:else}
        <div></div>
      {/if}
      {#if sprint.versionDecision?.nextVersion}
        <a href="/sprints/{sprint.versionDecision.nextVersion}" class="sprint-nav-link sprint-nav-next">
          v{sprint.versionDecision.nextVersion} &rarr;
        </a>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .back-link {
    display: inline-block;
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-decoration: none;
    margin-bottom: var(--space-2);
    transition: color var(--duration-fast);
  }

  .back-link:hover {
    color: var(--color-brand);
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: var(--space-5);
  }

  .page-title {
    font-size: var(--text-2xl);
    font-weight: 700;
    font-family: var(--font-mono);
    margin: 0 0 var(--space-1) 0;
  }

  .page-subtitle {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    margin: 0;
  }

  .page-theme {
    font-size: var(--text-xs);
    color: var(--color-brand);
    font-style: italic;
    margin: var(--space-1) 0 0 0;
    opacity: 0.85;
  }

  .page-sprintid {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--color-text-faint);
    margin: var(--space-1) 0 0 0;
    letter-spacing: 0.03em;
  }

  .duration-value {
    font-size: var(--text-base);
  }

  .header-badges {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .phase-badge {
    font-family: var(--font-mono);
    font-size: 10px;
  }

  .autonomous-badge {
    background: rgba(91, 138, 245, 0.12);
    color: var(--color-brand);
    border: 1px solid rgba(91, 138, 245, 0.35);
    font-size: var(--text-xs);
    font-weight: 700;
  }

  /* Gauge card variant */
  .gauge-card {
    padding: var(--space-2) var(--space-3);
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 120px;
  }

  /* Section headings */
  .section-heading {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    margin: var(--space-6) 0 var(--space-3) 0;
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--color-border);
  }

  .section-heading-label {
    font-size: var(--text-xs);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-text-faint);
  }

  .section-heading-count {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--color-text-faint);
  }

  /* Prev / next sprint navigation */
  .sprint-nav {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: var(--space-8);
    padding-top: var(--space-4);
    border-top: 1px solid var(--color-border);
  }

  .sprint-nav-link {
    font-size: var(--text-sm);
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--color-text-muted);
    text-decoration: none;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    transition: border-color var(--duration-fast), color var(--duration-fast), background var(--duration-fast);
  }

  .sprint-nav-link:hover {
    border-color: var(--color-brand);
    color: var(--color-brand);
    background: rgba(91, 138, 245, 0.06);
  }

  .sprint-nav-next {
    margin-left: auto;
  }

  /* Summary row */
  .summary-row {
    display: flex;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
    flex-wrap: wrap;
  }

  .summary-card {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    text-align: center;
    min-width: 90px;
  }

  .summary-card.highlight {
    border-color: var(--color-brand);
    background: rgba(91, 138, 245, 0.06);
  }

  .summary-card.highlight-success {
    border-color: var(--color-success);
    background: rgba(34, 197, 94, 0.06);
  }

  .test-delta {
    color: var(--color-success);
  }

  .summary-value {
    font-family: var(--font-mono);
    font-size: var(--text-lg);
    font-weight: 700;
    color: var(--color-text);
  }

  .date-value {
    font-size: var(--text-sm);
  }

  .summary-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: var(--space-1);
  }

  /* Item groups */
  .group-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-3);
  }

  .priority-badge {
    font-size: var(--text-xs);
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border-radius: var(--radius-full);
  }

  .priority-badge.danger {
    color: var(--color-danger);
    background: rgba(224,90,90,0.1);
    border: 1px solid rgba(224,90,90,0.3);
  }

  .priority-badge.warning {
    color: var(--color-warning);
    background: rgba(245,166,35,0.1);
    border: 1px solid rgba(245,166,35,0.3);
  }

  .priority-badge.muted {
    color: var(--color-text-muted);
    background: rgba(100,116,139,0.1);
    border: 1px solid rgba(100,116,139,0.3);
  }

  .group-count {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    font-family: var(--font-mono);
  }

  .item-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .sprint-item {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-1);
    transition: border-color var(--duration-fast);
  }

  .sprint-item:hover {
    border-color: var(--color-border-strong);
  }

  .sprint-item.completed {
    opacity: 0.65;
  }

  .sprint-item.blocked {
    border-left: 3px solid var(--color-danger);
  }

  .item-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 5px;
  }

  .item-body {
    flex: 1;
    min-width: 0;
  }

  .item-title {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text);
    margin-bottom: var(--space-1);
  }

  .sprint-item.completed .item-title {
    text-decoration: line-through;
    color: var(--color-text-muted);
  }

  .item-desc {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    line-height: 1.5;
    margin-bottom: var(--space-2);
  }

  .item-meta {
    display: flex;
    gap: var(--space-3);
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    flex-wrap: wrap;
    align-items: center;
  }

  .item-assignee {
    font-family: var(--font-mono);
    color: var(--color-text-muted);
  }

  .item-status-label {
    font-weight: 600;
  }
  .item-status-label.status-completed { color: var(--color-success); }
  .item-status-label.status-in_progress { color: var(--color-brand); }
  .item-status-label.status-blocked { color: var(--color-danger); }
  .item-status-label.status-pending { color: var(--color-text-faint); }
  .item-status-label.status-failed { color: var(--color-danger); }

  .sprint-item.failed {
    border-left: 3px solid var(--color-danger);
    opacity: 0.8;
  }

  .item-cost {
    font-family: var(--font-mono);
    color: var(--color-text-faint);
  }

  .item-source {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    background: rgba(100, 116, 139, 0.1);
    color: var(--color-text-faint);
    border: 1px solid rgba(100, 116, 139, 0.2);
    font-family: var(--font-mono);
  }

  .item-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: var(--space-2);
  }

  .item-tag {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    background: rgba(91, 138, 245, 0.08);
    color: var(--color-brand);
    border: 1px solid rgba(91, 138, 245, 0.25);
  }

  /* Criteria / findings */
  .criteria-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .criterion {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    font-size: var(--text-sm);
    color: var(--color-text);
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface-1);
    border-radius: var(--radius-sm);
    border-left: 3px solid var(--color-success);
    line-height: 1.5;
  }

  .criterion.finding {
    border-left-color: var(--color-warning);
  }

  .criterion-index {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-success);
    opacity: 0.7;
    flex-shrink: 0;
    min-width: 20px;
  }

  .criterion.finding .criterion-index {
    color: var(--color-warning);
    opacity: 0.8;
  }

  .criterion-text {
    flex: 1;
  }

  .criteria-card {
    border-left: 3px solid var(--color-success);
  }

  .findings-card {
    border-left: 3px solid var(--color-warning);
  }

  .section-empty {
    font-size: var(--text-sm);
    color: var(--color-text-faint);
    font-style: italic;
    padding: var(--space-2) var(--space-1);
  }

  /* Kanban */
  .kanban-board {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }

  @media (max-width: 900px) {
    .kanban-board {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (max-width: 580px) {
    .kanban-board {
      grid-template-columns: 1fr;
    }
  }

  .kanban-column {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    min-height: 160px;
  }

  .kanban-col-header {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
    padding-bottom: var(--space-2);
    border-bottom: 2px solid var(--color-border);
  }

  .kanban-col-title {
    font-size: var(--text-xs);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .kanban-col-count {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    font-family: var(--font-mono);
  }

  .kanban-col-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    flex: 1;
  }

  .kanban-empty {
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-sm);
    padding: var(--space-4);
    text-align: center;
    font-size: var(--text-xs);
    color: var(--color-text-faint);
  }

  .kanban-card {
    text-align: left;
    cursor: pointer;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    color: inherit;
    font: inherit;
    transition: border-color var(--duration-fast), box-shadow var(--duration-fast);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .kanban-card:hover {
    border-color: var(--color-brand);
    box-shadow: 0 2px 8px rgba(91,138,245,0.12);
  }

  .kanban-card-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .kanban-cost {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--color-text-muted);
  }

  .kanban-card-title {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text);
    line-height: 1.3;
  }

  .kanban-card-assignee {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--color-text-muted);
  }

  .kanban-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: var(--space-1);
  }

  .kanban-tag {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    background: rgba(91, 138, 245, 0.1);
    color: var(--color-brand);
    border: 1px solid rgba(91, 138, 245, 0.3);
  }

  .kanban-card-desc {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    line-height: 1.5;
    margin-top: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--color-border);
    white-space: pre-wrap;
  }

  /* 5-column kanban when failed items exist */
  .kanban-board.has-failed {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  @media (max-width: 1100px) {
    .kanban-board.has-failed {
      grid-template-columns: repeat(3, 1fr);
    }
  }

  @media (max-width: 900px) {
    .kanban-board.has-failed {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (max-width: 580px) {
    .kanban-board.has-failed {
      grid-template-columns: 1fr;
    }
  }

  /* Version decision card */
  .version-tier-badge {
    font-size: var(--text-xs);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 2px 10px;
    border-radius: var(--radius-full);
  }

  .version-tier-major {
    background: rgba(224, 90, 90, 0.12);
    color: var(--color-danger);
    border: 1px solid rgba(224, 90, 90, 0.35);
  }

  .version-tier-minor {
    background: rgba(245, 166, 35, 0.12);
    color: var(--color-warning);
    border: 1px solid rgba(245, 166, 35, 0.35);
  }

  .version-tier-patch {
    background: rgba(100, 116, 139, 0.1);
    color: var(--color-text-muted);
    border: 1px solid rgba(100, 116, 139, 0.3);
  }

  .version-bump-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .version-chip {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    font-weight: 600;
    padding: 2px 10px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-1);
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
  }

  .version-chip.highlight {
    background: rgba(91, 138, 245, 0.08);
    border-color: rgba(91, 138, 245, 0.35);
    color: var(--color-brand);
  }

  .version-arrow {
    font-size: var(--text-sm);
    color: var(--color-text-faint);
  }

  .version-rationale {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    margin: 0;
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface-1);
    border-radius: var(--radius-sm);
    border-left: 3px solid var(--color-border-strong);
    line-height: 1.6;
  }

  .version-tags-seen {
    margin-top: var(--space-3);
  }

  .version-tags-label {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    display: block;
    margin-bottom: var(--space-2);
  }

  .version-tags-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .version-tag-chip {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: var(--radius-full);
    background: rgba(100, 116, 139, 0.1);
    color: var(--color-text-faint);
    border: 1px solid rgba(100, 116, 139, 0.2);
    font-family: var(--font-mono);
  }
</style>
