<script lang="ts">
  /**
   * /flywheel/proposals/[id] — Skill Proposal detail view.
   *
   * Loads the proposal from GET /api/v5/flywheel/proposals (filtered by id).
   * Renders frontmatter metadata + body as markdown (via `marked`).
   * Approve → POST /api/v5/flywheel/proposals/:id/approve
   * Reject  → POST /api/v5/flywheel/proposals/:id/reject
   *
   * `if (browser)` guard around all document.* access.
   */
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
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

  let proposal = $state<SkillProposal | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let renderedBody = $state('');

  let actionInProgress = $state<'approve' | 'reject' | null>(null);
  let actionResult = $state<{ ok: boolean; message: string } | null>(null);

  // ── Data loading ───────────────────────────────────────────────────────────

  async function renderMarkdown(md: string): Promise<string> {
    if (!browser) return md;
    try {
      const { marked } = await import('marked');
      return String(await marked(md));
    } catch {
      // marked not available — fallback to pre-formatted text
      return `<pre>${md.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
    }
  }

  async function load(): Promise<void> {
    const id = $page.params['id'];
    if (!id) { error = 'Missing proposal id'; loading = false; return; }

    error = null;
    try {
      const res = await fetch(withWorkspace('/api/v5/flywheel/proposals'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data: SkillProposal[] };
      const found = (json.data ?? []).find((p) => p.id === id) ?? null;
      if (!found) throw new Error(`Proposal '${id}' not found`);
      proposal = found;
      renderedBody = await renderMarkdown(found.body);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => void load());

  // ── Actions ────────────────────────────────────────────────────────────────

  async function doAction(action: 'approve' | 'reject'): Promise<void> {
    if (!proposal) return;
    actionInProgress = action;
    actionResult = null;
    try {
      const res = await fetch(
        withWorkspace(`/api/v5/flywheel/proposals/${proposal.id}/${action}`),
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      actionResult = {
        ok: true,
        message:
          action === 'approve'
            ? 'Proposal approved and moved out of _proposed/.'
            : 'Proposal rejected and removed.',
      };
      // Reload to reflect updated status (or navigate back to list)
      setTimeout(() => goto('/flywheel/proposals'), 1200);
    } catch (e) {
      actionResult = { ok: false, message: e instanceof Error ? e.message : String(e) };
    } finally {
      actionInProgress = null;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function statusVariant(status: string): 'success' | 'warning' | 'muted' {
    if (status === 'approved') return 'success';
    if (status === 'rejected') return 'muted';
    return 'warning';
  }

  function fmtDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  const metaRows = $derived((() => {
    const p: SkillProposal | null = proposal;
    if (!p) return [];
    return [
      { label: 'ID', value: p.id },
      { label: 'Action', value: p.action },
      { label: 'Skill ID', value: p.skillId || '—' },
      { label: 'Target skill', value: p.targetSkillId ?? '—' },
      { label: 'Capability tag', value: p.capabilityTag || '—' },
      { label: 'Cluster', value: p.clusterId || '—' },
      { label: 'Occurrences', value: String(p.occurrences > 0 ? p.occurrences : '—') },
      { label: 'Requires tools', value: p.requiresTools.length > 0 ? p.requiresTools.join(', ') : '—' },
      { label: 'Created', value: fmtDate(p.createdAt) },
    ];
  })());
</script>

<svelte:head>
  <title>
    {proposal ? `Proposal: ${proposal.id}` : 'Proposal'} — AgentForge
  </title>
</svelte:head>

<!-- ── Page header ───────────────────────────────────────────────────────── -->
<header class="page-header">
  <div class="crumbs font-mono">
    <a href="/flywheel" class="crumb-link">Flywheel</a>
    &middot;
    <a href="/flywheel/proposals" class="crumb-link">Proposals</a>
    {#if proposal}
      &middot; {proposal.id}
    {/if}
  </div>
  <div class="headline-row">
    <div>
      <h1 class="page-title">
        {#if proposal}
          {proposal.id}
        {:else if loading}
          Loading…
        {:else}
          Proposal not found
        {/if}
      </h1>
      {#if proposal}
        <p class="page-sub">
          {proposal.action === 'create' ? 'New skill creation' : 'Skill refinement'} &middot;
          <span class="font-mono" style="color:var(--af-accent2)">{proposal.capabilityTag}</span>
        </p>
      {/if}
    </div>
    <div class="header-actions">
      <Btn size="sm" variant="ghost" onClick={() => goto('/flywheel/proposals')}>← Back</Btn>
    </div>
  </div>
</header>

{#if loading}
  <div class="skeleton" style="height:120px;border-radius:8px;margin-bottom:14px;"></div>
  <div class="skeleton" style="height:300px;border-radius:8px;"></div>

{:else if error}
  <div class="error-banner">
    {error}
    <Btn size="sm" onClick={() => void load()} style="margin-left:12px">Retry</Btn>
  </div>

{:else if proposal}
  <!-- ── Action result banner ─────────────────────────────────────────────── -->
  {#if actionResult}
    <div
      class="action-banner"
      class:action-banner-ok={actionResult.ok}
      class:action-banner-err={!actionResult.ok}
    >
      {actionResult.ok ? '✓' : '✗'} {actionResult.message}
    </div>
  {/if}

  <!-- ── Two-column layout ────────────────────────────────────────────────── -->
  <div class="detail-layout">

    <!-- Left: metadata + actions -->
    <aside class="meta-panel">
      <Card style="margin-bottom:12px;">
        <div class="section-label">STATUS</div>
        <div class="status-row">
          <Badge variant={statusVariant(proposal.status)} style="font-size:13px;padding:4px 12px;">
            {proposal.status.toUpperCase()}
          </Badge>
        </div>

        {#if proposal.status === 'proposed'}
          <div class="action-buttons">
            <Btn
              onClick={() => void doAction('approve')}
              disabled={actionInProgress !== null}
              style="width:100%;margin-bottom:8px;background:var(--af-success);color:#fff;"
            >
              {actionInProgress === 'approve' ? 'Approving…' : '✓ Approve'}
            </Btn>
            <Btn
              variant="ghost"
              onClick={() => void doAction('reject')}
              disabled={actionInProgress !== null}
              style="width:100%;color:var(--af-danger);border-color:var(--af-danger);"
            >
              {actionInProgress === 'reject' ? 'Rejecting…' : '✗ Reject'}
            </Btn>
          </div>
        {/if}
      </Card>

      <Card>
        <div class="section-label">METADATA</div>
        <dl class="meta-dl">
          {#each metaRows as row}
            <dt class="meta-dt">{row.label}</dt>
            <dd class="meta-dd font-mono">{row.value}</dd>
          {/each}
        </dl>
      </Card>
    </aside>

    <!-- Right: rendered body (diff / proposal content) -->
    <main class="body-panel">
      <Card noPad>
        <div class="body-header">
          <span class="section-label" style="margin:0;">PROPOSAL BODY</span>
          <Badge variant={proposal.action === 'create' ? 'purple' : 'muted'}>
            {proposal.action}
          </Badge>
        </div>
        {#if renderedBody}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          <div class="md-body">{@html renderedBody}</div>
        {:else}
          <div class="empty-state">No proposal body.</div>
        {/if}
      </Card>
    </main>
  </div>
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
  .crumb-link {
    color: var(--af-accent2);
    text-decoration: none;
    opacity: 0.8;
  }
  .crumb-link:hover { opacity: 1; text-decoration: underline; }
  .headline-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .page-title {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--af-text);
    word-break: break-all;
  }
  .page-sub {
    font-size: 12px;
    color: var(--af-muted);
    margin: 4px 0 0;
  }
  .header-actions { display: flex; align-items: center; gap: 8px; }

  /* ── Action result banner ──────────────────────────────────────────────────── */
  .action-banner {
    padding: 10px 14px;
    border-radius: 6px;
    font-size: 13px;
    margin-bottom: 12px;
  }
  .action-banner-ok {
    background: color-mix(in srgb, var(--af-success) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-success) 30%, transparent);
    color: var(--af-success);
  }
  .action-banner-err {
    background: color-mix(in srgb, var(--af-danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-danger) 30%, transparent);
    color: var(--af-danger);
  }

  /* ── Two-column layout ─────────────────────────────────────────────────────── */
  .detail-layout {
    display: grid;
    grid-template-columns: 260px 1fr;
    gap: 14px;
    align-items: start;
  }
  @media (max-width: 860px) {
    .detail-layout { grid-template-columns: 1fr; }
  }
  .meta-panel { display: flex; flex-direction: column; gap: 12px; }
  .body-panel { min-width: 0; }

  /* ── Section labels ────────────────────────────────────────────────────────── */
  .section-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    text-transform: uppercase;
    margin-bottom: 10px;
    display: block;
  }

  /* ── Status + action buttons ───────────────────────────────────────────────── */
  .status-row { margin-bottom: 14px; }
  .action-buttons { display: flex; flex-direction: column; }

  /* ── Metadata DL ───────────────────────────────────────────────────────────── */
  .meta-dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    margin: 0;
  }
  .meta-dt {
    font-size: 10px;
    color: var(--af-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
    padding-top: 2px;
  }
  .meta-dd {
    font-size: 11px;
    color: var(--af-text);
    margin: 0;
    word-break: break-all;
  }

  /* ── Body panel ────────────────────────────────────────────────────────────── */
  .body-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--af-border);
  }
  .md-body {
    padding: 16px;
    font-size: 13px;
    line-height: 1.7;
    color: var(--af-muted);
  }
  /* Prose styles for rendered markdown */
  .md-body :global(h1),
  .md-body :global(h2),
  .md-body :global(h3) {
    color: var(--af-text);
    margin: 1em 0 0.5em;
    font-weight: 600;
  }
  .md-body :global(h1) { font-size: 18px; }
  .md-body :global(h2) { font-size: 15px; }
  .md-body :global(h3) { font-size: 13px; }
  .md-body :global(p) { margin: 0 0 0.8em; }
  .md-body :global(ul),
  .md-body :global(ol) { margin: 0 0 0.8em 1.4em; }
  .md-body :global(li) { margin-bottom: 4px; }
  .md-body :global(code) {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 11px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border);
    padding: 1px 5px;
    border-radius: 3px;
    color: var(--af-accent2);
  }
  .md-body :global(pre) {
    background: var(--af-surface);
    border: 1px solid var(--af-border);
    border-radius: 6px;
    padding: 12px;
    overflow-x: auto;
    font-size: 11px;
    margin: 0 0 0.8em;
  }
  .md-body :global(pre code) {
    background: none;
    border: none;
    padding: 0;
    color: var(--af-text);
  }
  .md-body :global(strong) { color: var(--af-text); font-weight: 600; }
  .md-body :global(blockquote) {
    border-left: 3px solid var(--af-accent);
    margin: 0 0 0.8em;
    padding: 4px 12px;
    color: var(--af-dim);
  }
  .md-body :global(hr) {
    border: none;
    border-top: 1px solid var(--af-border);
    margin: 1em 0;
  }

  /* ── Empty + Error ─────────────────────────────────────────────────────────── */
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

  /* ── Skeleton ──────────────────────────────────────────────────────────────── */
  .skeleton {
    background: linear-gradient(90deg, var(--af-surface) 0%, var(--af-surface2) 50%, var(--af-surface) 100%);
    background-size: 200% 100%;
    animation: skel 1.4s ease-in-out infinite;
  }
  @keyframes skel {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
</style>
