<script lang="ts">
  /**
   * /flywheel/proposals — Skill Proposals list view.
   *
   * Reads GET /api/v5/flywheel/proposals and renders a filterable table.
   * Each row is clickable, navigating to /flywheel/proposals/[id].
   *
   * Search uses String.includes() to avoid regex ReDoS on user input.
   */
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { Card, Badge, Btn } from '$lib/components/v2';
  import { withWorkspace } from '$lib/stores/workspace';

  // ── Types ──────────────────────────────────────────────────────────────────

  interface SkillProposal {
    id: string;
    action: 'refine' | 'create';
    targetSkillId: string | null;
    skillId: string;
    capabilityTag: string;
    clusterId: string;
    requiresTools: string[];
    frontmatter: Record<string, unknown>;
    body: string;
    status: 'proposed' | 'approved' | 'rejected';
    createdAt: string;
    occurrences: number;
  }

  // ── State ──────────────────────────────────────────────────────────────────

  let proposals: SkillProposal[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);
  let searchQuery = $state('');

  const POLL_MS = 30_000;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // ── Data loading ───────────────────────────────────────────────────────────

  async function load(): Promise<void> {
    error = null;
    try {
      const res = await fetch(withWorkspace('/api/v5/flywheel/proposals'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data: SkillProposal[] };
      proposals = json.data ?? [];
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function handleVisibilityChange(): void {
    if (!browser) return;
    if (document.visibilityState === 'visible') void load();
  }

  onMount(() => {
    void load();
    pollTimer = setInterval(() => {
      if (browser && document.visibilityState !== 'visible') return;
      void load();
    }, POLL_MS);
    if (browser) document.addEventListener('visibilitychange', handleVisibilityChange);
  });

  onDestroy(() => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (browser) document.removeEventListener('visibilitychange', handleVisibilityChange);
  });

  // ── Derived ────────────────────────────────────────────────────────────────

  const filtered = $derived((() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return proposals;
    // String.includes — no regex on user input
    return proposals.filter(
      (p) =>
        p.id.toLowerCase().includes(q) ||
        p.capabilityTag.toLowerCase().includes(q) ||
        p.clusterId.toLowerCase().includes(q) ||
        p.action.includes(q) ||
        p.status.includes(q),
    );
  })());

  const proposedCount = $derived(proposals.filter((p) => p.status === 'proposed').length);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function statusVariant(status: string): 'success' | 'warning' | 'muted' | 'purple' {
    if (status === 'approved') return 'success';
    if (status === 'rejected') return 'muted';
    return 'warning';
  }

  function actionVariant(action: string): 'purple' | 'muted' {
    return action === 'create' ? 'purple' : 'muted';
  }

  function fmtDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return iso;
    }
  }
</script>

<svelte:head><title>Flywheel Proposals — AgentForge</title></svelte:head>

<!-- ── Page header ───────────────────────────────────────────────────────── -->
<header class="page-header">
  <div class="crumbs font-mono">Workspace · Flywheel · Proposals</div>
  <div class="headline-row">
    <div>
      <h1 class="page-title">Skill Proposals</h1>
      <p class="page-sub">
        Proposed skill refinements and creations from flywheel cluster analysis
        {#if !loading && proposedCount > 0}
          &middot; <span class="pending-count font-mono">{proposedCount} pending</span>
        {/if}
      </p>
    </div>
    <div class="header-actions">
      <Btn size="sm" onClick={() => void load()}>&#8635; Refresh</Btn>
    </div>
  </div>
</header>

<!-- ── Search bar ─────────────────────────────────────────────────────────── -->
<div class="search-row">
  <input
    class="search-input font-mono"
    type="text"
    placeholder="Filter by id, capability tag, cluster…"
    bind:value={searchQuery}
  />
</div>

{#if loading}
  <!-- Skeleton -->
  <Card>
    {#each Array(4) as _}
      <div class="skeleton-row"></div>
    {/each}
  </Card>

{:else if error}
  <div class="error-banner">
    Failed to load proposals: {error}
    <Btn size="sm" onClick={() => void load()} style="margin-left:12px">Retry</Btn>
  </div>

{:else if filtered.length === 0}
  <Card>
    <div class="empty-state">
      {#if searchQuery}
        No proposals match "{searchQuery}"
      {:else}
        No skill proposals found in <code class="font-mono">skills/agentforge/_proposed/</code>
      {/if}
    </div>
  </Card>

{:else}
  <Card noPad>
    <table class="data-table">
      <thead>
        <tr>
          <th>Proposal ID</th>
          <th>Action</th>
          <th>Capability Tag</th>
          <th>Cluster</th>
          <th>Occurrences</th>
          <th>Status</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {#each filtered as proposal (proposal.id)}
          <tr
            class="proposal-row"
            role="button"
            tabindex="0"
            onclick={() => goto(`/flywheel/proposals/${proposal.id}`)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') goto(`/flywheel/proposals/${proposal.id}`); }}
          >
            <td class="id-cell font-mono">{proposal.id}</td>
            <td>
              <Badge variant={actionVariant(proposal.action)}>
                {proposal.action}
              </Badge>
            </td>
            <td class="font-mono cap-tag">{proposal.capabilityTag || '—'}</td>
            <td class="font-mono cluster-id">{proposal.clusterId || '—'}</td>
            <td class="font-mono occ-cell">{proposal.occurrences > 0 ? proposal.occurrences : '—'}</td>
            <td>
              <Badge variant={statusVariant(proposal.status)}>
                {proposal.status}
              </Badge>
            </td>
            <td class="font-mono date-cell">{fmtDate(proposal.createdAt)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </Card>
{/if}

<style>
  /* ── Page header ──────────────────────────────────────────────────────────── */
  .page-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
  }
  .crumbs {
    font-size: 11px;
    color: var(--af-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .headline-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .page-title {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--af-text);
  }
  .page-sub {
    font-size: 12px;
    color: var(--af-muted);
    margin: 4px 0 0;
  }
  .pending-count { color: var(--af-warning); font-weight: 600; }
  .header-actions { display: flex; align-items: center; gap: 8px; }

  /* ── Search ───────────────────────────────────────────────────────────────── */
  .search-row {
    margin-bottom: 12px;
  }
  .search-input {
    width: 100%;
    max-width: 440px;
    padding: 7px 12px;
    border: 1px solid var(--af-border);
    border-radius: 6px;
    background: var(--af-surface2);
    color: var(--af-text);
    font-size: 12px;
    outline: none;
    transition: border-color 0.15s;
  }
  .search-input:focus { border-color: var(--af-accent); }
  .search-input::placeholder { color: var(--af-faint); }

  /* ── Table ────────────────────────────────────────────────────────────────── */
  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .data-table th {
    text-align: left;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--af-dim);
    padding: 8px 14px;
    border-bottom: 1px solid var(--af-border);
    white-space: nowrap;
  }
  .data-table td {
    padding: 8px 14px;
    border-bottom: 1px solid color-mix(in srgb, var(--af-border) 50%, transparent);
    color: var(--af-muted);
    vertical-align: middle;
  }
  .proposal-row {
    cursor: pointer;
    transition: background 0.1s;
  }
  .proposal-row:hover td { background: color-mix(in srgb, var(--af-accent) 5%, transparent); }
  .proposal-row:focus-visible td { outline: 2px solid var(--af-accent); outline-offset: -2px; }

  .id-cell { color: var(--af-text); font-weight: 500; font-size: 11px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cap-tag { color: var(--af-accent2); font-size: 11px; }
  .cluster-id { font-size: 11px; color: var(--af-dim); }
  .occ-cell { font-size: 11px; color: var(--af-muted); }
  .date-cell { font-size: 11px; color: var(--af-faint); white-space: nowrap; }

  /* ── Skeleton ─────────────────────────────────────────────────────────────── */
  .skeleton-row {
    height: 36px;
    border-radius: 4px;
    margin-bottom: 8px;
    background: linear-gradient(90deg, var(--af-surface) 0%, var(--af-surface2) 50%, var(--af-surface) 100%);
    background-size: 200% 100%;
    animation: skel 1.4s ease-in-out infinite;
  }
  @keyframes skel {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  /* ── Empty + Error ────────────────────────────────────────────────────────── */
  .empty-state {
    padding: 28px;
    text-align: center;
    font-size: 13px;
    color: var(--af-faint);
  }
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
</style>
