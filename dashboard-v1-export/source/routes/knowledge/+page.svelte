<script lang="ts">
  import { onMount } from 'svelte';

  // Dashboard view-model mapped from server `Entity` shape:
  //   { id, name, type, description, properties, createdAt }
  // The dashboard historically rendered "content + tags + sourceAgent", so we
  // adapt:
  //   content     = description ?? name
  //   tags        = [type]  (entity type is the single categorical tag)
  //   sourceAgent = properties.sourceAgent ?? '—'
  interface KnowledgeEntry {
    id: string;
    content: string;
    sourceAgent: string;
    tags: string[];
    createdAt: string;
  }

  interface KnowledgeStats {
    total: number;
    agents: number;
    tags: number;
    lastUpdated?: string;
  }

  let entries: KnowledgeEntry[] = [];
  let stats: KnowledgeStats = { total: 0, agents: 0, tags: 0 };
  let loading = true;
  let statsLoading = true;
  let error: string | null = null;

  let searchQuery = '';
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  let searching = false;

  // Add entry form
  let showAddForm = false;
  let addContent = '';
  let addTags = '';
  let addSourceAgent = '';
  let addSubmitting = false;
  let addError: string | null = null;
  let addSuccess = false;

  async function loadStats() {
    statsLoading = true;
    try {
      const res = await fetch('/api/v5/knowledge/graph');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const graph = json.data ?? {};
      const graphStats = graph.stats ?? {};
      const allEntities: Array<Record<string, unknown>> = Array.isArray(graph.entities) ? graph.entities : [];
      const agentSet = new Set<string>();
      for (const e of allEntities) {
        const props = (e.properties ?? {}) as Record<string, unknown>;
        const agent = String(props.sourceAgent ?? props.source_agent ?? '').trim();
        if (agent) agentSet.add(agent);
      }
      const tagSet = new Set(allEntities.map((e) => String(e.type ?? '')).filter(Boolean));
      // Newest createdAt for "last updated"
      let lastUpdated: string | undefined;
      for (const e of allEntities) {
        const t = String(e.createdAt ?? '');
        if (t && (!lastUpdated || t > lastUpdated)) lastUpdated = t;
      }
      stats = {
        total: Number(graphStats.entityCount ?? allEntities.length),
        agents: agentSet.size,
        tags: tagSet.size,
        ...(lastUpdated ? { lastUpdated } : {}),
      };
    } catch {
      // non-critical; leave prior stats as-is
    } finally {
      statsLoading = false;
    }
  }

  async function loadEntries(q = '') {
    loading = true;
    error = null;
    try {
      let raw: unknown[] = [];
      if (q) {
        // Semantic query — POST /api/v5/knowledge/query returns
        // { data: { entities: [...], relationships: [...], relevanceScores: {...} } }
        const res = await fetch('/api/v5/knowledge/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q, maxEntities: 50 }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        raw = Array.isArray(json.data?.entities) ? json.data.entities : [];
      } else {
        // Full list
        const res = await fetch('/api/v5/knowledge/entities');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        raw = Array.isArray(json.data) ? json.data : [];
      }
      entries = raw.map(normalizeEntry);
      if (!q) updateStatsFromEntries();
    } catch (e) {
      error = String(e);
      entries = [];
    } finally {
      loading = false;
      searching = false;
    }
  }

  function normalizeEntry(raw: unknown): KnowledgeEntry {
    const r = raw as Record<string, unknown>;
    const props = (r.properties ?? {}) as Record<string, unknown>;
    const description = String(r.description ?? '').trim();
    const name = String(r.name ?? '').trim();
    const content = description || name || '(no description)';
    const type = String(r.type ?? '').trim();
    return {
      id: String(r.id ?? ''),
      content,
      sourceAgent: String(props.sourceAgent ?? props.source_agent ?? r.sourceAgent ?? '—'),
      tags: type ? [type] : [],
      createdAt: String(r.createdAt ?? r.created_at ?? new Date().toISOString()),
    };
  }

  function updateStatsFromEntries() {
    // Fallback stats derivation when loadStats hasn't completed yet.
    if (statsLoading) return;
  }

  function handleSearchInput() {
    if (searchDebounce) clearTimeout(searchDebounce);
    searching = true;
    searchDebounce = setTimeout(() => {
      loadEntries(searchQuery.trim());
    }, 300);
  }

  function clearSearch() {
    searchQuery = '';
    loadEntries('');
  }

  async function handleAddEntry() {
    if (!addContent.trim()) return;
    addSubmitting = true;
    addError = null;
    addSuccess = false;
    try {
      // Map the UI form onto the server entity model.
      // The user types natural content; we use the first line (truncated) as
      // `name`, the full text as `description`, first tag as `type` (defaults
      // to 'concept'), and stash sourceAgent in `properties`.
      const tags = addTags.split(',').map((t) => t.trim()).filter(Boolean);
      const content = addContent.trim();
      const name = content.split('\n')[0]?.slice(0, 80) || 'untitled';
      const res = await fetch('/api/v5/knowledge/entities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          type: tags[0] ?? 'concept',
          description: content,
          properties: {
            sourceAgent: addSourceAgent.trim() || 'dashboard-user',
            ...(tags.length > 1 ? { extraTags: tags.slice(1) } : {}),
          },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      addSuccess = true;
      addContent = '';
      addTags = '';
      addSourceAgent = '';
      showAddForm = false;
      await loadEntries(searchQuery.trim());
      await loadStats();
    } catch (e) {
      addError = String(e);
    } finally {
      addSubmitting = false;
    }
  }

  function truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  function fmtDate(iso: string): string {
    try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return iso; }
  }

  function fmtRelative(iso: string): string {
    try {
      const diff = Date.now() - new Date(iso).getTime();
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
      return fmtDate(iso);
    } catch { return iso; }
  }

  onMount(() => {
    loadEntries();
    loadStats();
  });
</script>

<svelte:head><title>Knowledge — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Knowledge Graph</h1>
    <p class="page-subtitle">Shared knowledge store across the autonomous agent team</p>
  </div>
  <button class="btn btn-primary btn-sm" onclick={() => { showAddForm = !showAddForm; addError = null; }}>
    {showAddForm ? 'Cancel' : '+ Add Entry'}
  </button>
</div>

<!-- Stats row -->
<div class="stats-row">
  <div class="stat-item">
    <span class="stat-value">{statsLoading ? '…' : stats.total.toLocaleString()}</span>
    <span class="stat-label">Total Entries</span>
  </div>
  <div class="stat-divider"></div>
  <div class="stat-item">
    <span class="stat-value">{statsLoading ? '…' : stats.agents}</span>
    <span class="stat-label">Contributing Agents</span>
  </div>
  <div class="stat-divider"></div>
  <div class="stat-item">
    <span class="stat-value">{statsLoading ? '…' : stats.tags}</span>
    <span class="stat-label">Unique Tags</span>
  </div>
  {#if stats.lastUpdated}
    <div class="stat-divider"></div>
    <div class="stat-item">
      <span class="stat-value">{fmtRelative(stats.lastUpdated)}</span>
      <span class="stat-label">Last Updated</span>
    </div>
  {/if}
</div>

<!-- Add Entry Form -->
{#if showAddForm}
  <div class="add-form card">
    <div class="card-header">
      <span class="card-title">New Knowledge Entry</span>
    </div>

    <div class="form-group">
      <label class="form-label" for="add-content">Content</label>
      <textarea
        id="add-content"
        class="form-textarea"
        rows={4}
        placeholder="Enter the knowledge to store…"
        bind:value={addContent}
        disabled={addSubmitting}
      ></textarea>
    </div>

    <div class="form-row">
      <div class="form-group" style="flex:1">
        <label class="form-label" for="add-tags">Tags (comma-separated)</label>
        <input
          id="add-tags"
          type="text"
          class="form-input"
          placeholder="e.g. architecture, api, performance"
          bind:value={addTags}
          disabled={addSubmitting}
        />
      </div>
      <div class="form-group" style="flex:1">
        <label class="form-label" for="add-agent">Source Agent</label>
        <input
          id="add-agent"
          type="text"
          class="form-input"
          placeholder="dashboard-user"
          bind:value={addSourceAgent}
          disabled={addSubmitting}
        />
      </div>
    </div>

    {#if addError}
      <div class="error-msg">{addError}</div>
    {/if}

    {#if addSuccess}
      <div class="success-msg">Entry added successfully.</div>
    {/if}

    <div class="form-actions">
      <button class="btn btn-ghost btn-sm" onclick={() => { showAddForm = false; addError = null; }}>
        Cancel
      </button>
      <button
        class="btn btn-primary btn-sm"
        disabled={addSubmitting || !addContent.trim()}
        onclick={handleAddEntry}
      >
        {addSubmitting ? 'Saving…' : 'Save Entry'}
      </button>
    </div>
  </div>
{/if}

<!-- Search -->
<div class="search-bar">
  <div class="search-input-wrap">
    <span class="search-icon">⌕</span>
    <input
      type="text"
      class="search-input"
      placeholder="Search knowledge entries…"
      bind:value={searchQuery}
      oninput={handleSearchInput}
    />
    {#if searchQuery}
      <button class="search-clear" onclick={clearSearch}>✕</button>
    {/if}
  </div>
  {#if searching}
    <span class="searching-hint">Searching…</span>
  {:else if searchQuery}
    <span class="searching-hint">{entries.length} result{entries.length !== 1 ? 's' : ''} for "{searchQuery}"</span>
  {/if}
</div>

<!-- Results -->
{#if error}
  <div class="error-banner">{error}</div>
{/if}

{#if loading && entries.length === 0}
  <div class="entries-list">
    {#each Array(4) as _}
      <div class="skeleton" style="height:100px;border-radius:var(--radius-lg);"></div>
    {/each}
  </div>
{:else if entries.length === 0}
  <div class="empty-state">
    <span style="font-size:36px;opacity:0.15;">◈</span>
    <p>{searchQuery ? `No entries found for "${searchQuery}"` : 'No knowledge entries yet.'}</p>
    {#if !searchQuery}
      <p style="font-size:var(--text-xs);color:var(--color-text-faint);">Agents will populate this store as they learn. You can also add entries manually.</p>
    {:else}
      <button class="btn btn-ghost btn-sm" style="margin-top:var(--space-3)" onclick={clearSearch}>Clear search</button>
    {/if}
  </div>
{:else}
  <div class="entries-list">
    {#each entries as entry (entry.id)}
      <div class="entry-card card">
        <div class="entry-content">{truncate(entry.content, 120)}</div>
        <div class="entry-footer">
          <div class="entry-tags">
            {#each entry.tags as tag}
              <button class="tag-pill" onclick={() => { searchQuery = tag; handleSearchInput(); }}>
                {tag}
              </button>
            {/each}
          </div>
          <div class="entry-meta">
            <span class="entry-agent">{entry.sourceAgent}</span>
            <span class="meta-sep">·</span>
            <span class="entry-date" title={fmtDate(entry.createdAt)}>{fmtRelative(entry.createdAt)}</span>
          </div>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  /* Stats row */
  .stats-row {
    display: flex;
    align-items: center;
    gap: var(--space-5);
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4) var(--space-6);
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }

  .stat-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .stat-value {
    font-family: var(--font-mono);
    font-size: var(--text-xl);
    font-weight: 700;
    color: var(--color-text);
    line-height: 1;
  }

  .stat-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    white-space: nowrap;
  }

  .stat-divider {
    width: 1px;
    height: 32px;
    background: var(--color-border);
  }

  /* Banners */
  .error-banner {
    background: rgba(224,90,90,0.08);
    border: 1px solid rgba(224,90,90,0.25);
    border-radius: var(--radius-md);
    color: var(--color-danger);
    font-size: var(--text-xs);
    padding: var(--space-2) var(--space-4);
    margin-bottom: var(--space-3);
  }

  /* Add form */
  .add-form {
    margin-bottom: var(--space-4);
  }

  .form-group {
    margin-bottom: var(--space-3);
  }

  .form-row {
    display: flex;
    gap: var(--space-3);
  }

  .form-label {
    display: block;
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-text-muted);
    margin-bottom: var(--space-1);
  }

  .form-textarea {
    width: 100%;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    resize: vertical;
    transition: border-color var(--duration-fast);
    box-sizing: border-box;
  }

  .form-textarea:focus {
    outline: none;
    border-color: var(--color-brand);
  }

  .form-textarea::placeholder { color: var(--color-text-faint); }

  .form-input {
    width: 100%;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    transition: border-color var(--duration-fast);
    box-sizing: border-box;
  }

  .form-input:focus {
    outline: none;
    border-color: var(--color-brand);
  }

  .form-input::placeholder { color: var(--color-text-faint); }

  .error-msg {
    background: rgba(224,90,90,0.1);
    border: 1px solid rgba(224,90,90,0.3);
    border-radius: var(--radius-md);
    color: var(--color-danger);
    font-size: var(--text-xs);
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-3);
  }

  .success-msg {
    background: rgba(76,175,130,0.1);
    border: 1px solid rgba(76,175,130,0.3);
    border-radius: var(--radius-md);
    color: var(--color-success);
    font-size: var(--text-xs);
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-3);
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  /* Search bar */
  .search-bar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }

  .search-input-wrap {
    position: relative;
    flex: 1;
    max-width: 480px;
  }

  .search-icon {
    position: absolute;
    left: var(--space-3);
    top: 50%;
    transform: translateY(-50%);
    font-size: var(--text-base);
    color: var(--color-text-faint);
    pointer-events: none;
    line-height: 1;
  }

  .search-input {
    width: 100%;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    padding: var(--space-2) var(--space-8) var(--space-2) 36px;
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    transition: border-color var(--duration-fast);
    box-sizing: border-box;
  }

  .search-input:focus {
    outline: none;
    border-color: var(--color-brand);
  }

  .search-input::placeholder { color: var(--color-text-faint); }

  .search-clear {
    position: absolute;
    right: var(--space-2);
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--color-text-faint);
    cursor: pointer;
    font-size: var(--text-xs);
    padding: var(--space-1);
    border-radius: var(--radius-sm);
    line-height: 1;
  }

  .search-clear:hover { color: var(--color-text-muted); }

  .searching-hint {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    white-space: nowrap;
  }

  /* Entries */
  .entries-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .entry-card {
    padding: var(--space-4) var(--space-5);
  }

  .entry-card:hover {
    transform: none;
    box-shadow: none;
    border-color: var(--color-border-strong);
  }

  .entry-content {
    font-size: var(--text-sm);
    color: var(--color-text);
    line-height: 1.6;
    margin-bottom: var(--space-3);
  }

  .entry-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .entry-tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .tag-pill {
    background: rgba(91,138,245,0.1);
    border: 1px solid rgba(91,138,245,0.25);
    border-radius: var(--radius-full);
    color: var(--color-brand);
    font-size: 10px;
    font-weight: 500;
    padding: 2px 8px;
    cursor: pointer;
    transition: background var(--duration-fast), border-color var(--duration-fast);
    white-space: nowrap;
  }

  .tag-pill:hover {
    background: rgba(91,138,245,0.18);
    border-color: rgba(91,138,245,0.4);
  }

  .entry-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .entry-agent {
    font-family: var(--font-mono);
    color: var(--color-text-muted);
    font-size: 11px;
  }

  .meta-sep { color: var(--color-text-faint); opacity: 0.5; }

  .entry-date {
    color: var(--color-text-faint);
  }
</style>
