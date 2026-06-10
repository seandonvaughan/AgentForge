<script lang="ts">
  /**
   * /knowledge — v25 rebuild: NOTES are the default view.
   *
   * Tabs:
   *   Notes (default) — full-text knowledge notes from GET /api/v5/knowledge/notes
   *                     (epic-review rationales, agent LEARNED notes,
   *                     audit/review summaries) with source badge, tags, date,
   *                     and limit/offset pagination.
   *   Graph           — the legacy entity/term browser (semantic search +
   *                     manual add-entry form) moved to a secondary tab.
   */
  import { onMount } from 'svelte';

  // ── Notes view (default) ─────────────────────────────────────────────────────

  interface KnowledgeNote {
    id: string;
    content: string;
    source: string;
    tags: string[];
    createdAt: string;
  }

  const NOTES_PAGE_SIZE = 50;

  let activeTab: 'notes' | 'graph' = $state('notes');

  let notes: KnowledgeNote[] = $state([]);
  let notesTotal = $state(0);
  let notesOffset = $state(0);
  let notesLoading = $state(true);
  let notesError: string | null = $state(null);

  async function loadNotes(offset = 0): Promise<void> {
    notesLoading = true;
    notesError = null;
    try {
      const res = await fetch(`/api/v5/knowledge/notes?limit=${NOTES_PAGE_SIZE}&offset=${offset}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as {
        data?: KnowledgeNote[];
        meta?: { total?: number; offset?: number };
      };
      notes = Array.isArray(json.data) ? json.data : [];
      notesTotal = typeof json.meta?.total === 'number' ? json.meta.total : notes.length;
      notesOffset = offset;
    } catch (e) {
      notesError = String(e);
      notes = [];
    } finally {
      notesLoading = false;
    }
  }

  function sourceVariant(source: string): string {
    if (source === 'epic-review') return 'note-src-epic';
    if (source === 'agent-learned') return 'note-src-learned';
    if (source === 'audit' || source === 'review') return 'note-src-phase';
    return 'note-src-other';
  }

  // ── Graph view (legacy entity browser, secondary tab) ───────────────────────

  // Dashboard view-model mapped from server `Entity` shape:
  //   { id, name, type, description, properties, createdAt }
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

  let entries: KnowledgeEntry[] = $state([]);
  let stats: KnowledgeStats = $state({ total: 0, agents: 0, tags: 0 });
  let loading = $state(true);
  let statsLoading = $state(true);
  let error: string | null = $state(null);
  let graphLoaded = $state(false);

  let searchQuery = $state('');
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  let searching = $state(false);

  // Add entry form
  let showAddForm = $state(false);
  let addContent = $state('');
  let addTags = $state('');
  let addSourceAgent = $state('');
  let addSubmitting = $state(false);
  let addError: string | null = $state(null);
  let addSuccess = $state(false);

  async function loadStats(): Promise<void> {
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

  async function loadEntries(q = ''): Promise<void> {
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

  function setTab(tab: 'notes' | 'graph'): void {
    activeTab = tab;
    if (tab === 'graph' && !graphLoaded) {
      graphLoaded = true;
      void loadEntries();
      void loadStats();
    }
  }

  function handleSearchInput(): void {
    if (searchDebounce) clearTimeout(searchDebounce);
    searching = true;
    searchDebounce = setTimeout(() => {
      void loadEntries(searchQuery.trim());
    }, 300);
  }

  function clearSearch(): void {
    searchQuery = '';
    void loadEntries('');
  }

  async function handleAddEntry(): Promise<void> {
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
    void loadNotes(0);
  });
</script>

<svelte:head><title>Knowledge — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Knowledge</h1>
    <p class="page-subtitle">Shared knowledge store across the autonomous agent team</p>
  </div>
  {#if activeTab === 'graph'}
    <button class="btn btn-primary btn-sm" onclick={() => { showAddForm = !showAddForm; addError = null; }}>
      {showAddForm ? 'Cancel' : '+ Add Entry'}
    </button>
  {/if}
</div>

<!-- Tabs: Notes (default) / Graph (legacy entity browser) -->
<div class="tab-row" role="tablist">
  <button
    class="tab-btn"
    class:tab-btn-active={activeTab === 'notes'}
    role="tab"
    aria-selected={activeTab === 'notes'}
    onclick={() => setTab('notes')}
  >Notes</button>
  <button
    class="tab-btn"
    class:tab-btn-active={activeTab === 'graph'}
    role="tab"
    aria-selected={activeTab === 'graph'}
    onclick={() => setTab('graph')}
  >Graph</button>
</div>

{#if activeTab === 'notes'}
  <!-- ── Notes view (default) ─────────────────────────────────────────────── -->
  {#if notesError}
    <div class="error-banner">{notesError}</div>
  {/if}

  {#if notesLoading && notes.length === 0}
    <div class="entries-list">
      {#each Array(4) as _}
        <div class="skeleton" style="height:100px;border-radius:var(--radius-lg);"></div>
      {/each}
    </div>
  {:else if notes.length === 0}
    <div class="empty-state">
      <span style="font-size:36px;opacity:0.15;">◈</span>
      <p>No knowledge notes yet.</p>
      <p style="font-size:var(--text-xs);color:var(--color-text-faint);">
        Knowledge notes are written by epic reviews and agent LEARNED notes from
        cycles run after v25.
      </p>
    </div>
  {:else}
    <div class="notes-meta">
      <span class="notes-count">
        {notesTotal} note{notesTotal !== 1 ? 's' : ''} ·
        showing {notesOffset + 1}–{Math.min(notesOffset + notes.length, notesTotal)}
      </span>
      <div class="notes-pager">
        <button
          class="btn btn-ghost btn-sm"
          disabled={notesOffset === 0 || notesLoading}
          onclick={() => void loadNotes(Math.max(0, notesOffset - NOTES_PAGE_SIZE))}
        >← Newer</button>
        <button
          class="btn btn-ghost btn-sm"
          disabled={notesOffset + NOTES_PAGE_SIZE >= notesTotal || notesLoading}
          onclick={() => void loadNotes(notesOffset + NOTES_PAGE_SIZE)}
        >Older →</button>
      </div>
    </div>

    <div class="entries-list">
      {#each notes as note (note.id)}
        <div class="entry-card card note-card">
          <div class="note-head">
            <span class="source-badge {sourceVariant(note.source)}">{note.source}</span>
            <span class="entry-date" title={fmtDate(note.createdAt)}>{fmtRelative(note.createdAt)}</span>
          </div>
          <div class="note-content">{note.content}</div>
          {#if note.tags.length > 0}
            <div class="entry-tags">
              {#each note.tags as tag}
                <span class="tag-pill tag-static">{tag}</span>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

{:else}
  <!-- ── Graph view (legacy entity browser) ───────────────────────────────── -->

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
{/if}

<style>
  /* Tabs */
  .tab-row {
    display: flex;
    gap: var(--space-1);
    border-bottom: 1px solid var(--color-border);
    margin-bottom: var(--space-4);
  }

  .tab-btn {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    font-weight: 500;
    padding: var(--space-2) var(--space-4);
    cursor: pointer;
    transition: color var(--duration-fast), border-color var(--duration-fast);
  }

  .tab-btn:hover { color: var(--color-text); }

  .tab-btn-active {
    color: var(--color-text);
    border-bottom-color: var(--color-brand);
  }

  /* Notes view */
  .notes-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
    flex-wrap: wrap;
  }

  .notes-count {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }

  .notes-pager {
    display: flex;
    gap: var(--space-2);
  }

  .note-card { padding: var(--space-4) var(--space-5); }

  .note-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }

  .source-badge {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: var(--radius-full);
    white-space: nowrap;
  }

  .note-src-epic {
    background: rgba(91,138,245,0.12);
    border: 1px solid rgba(91,138,245,0.3);
    color: var(--color-brand);
  }

  .note-src-learned {
    background: rgba(167,112,239,0.12);
    border: 1px solid rgba(167,112,239,0.3);
    color: #a770ef;
  }

  .note-src-phase {
    background: rgba(76,175,130,0.12);
    border: 1px solid rgba(76,175,130,0.3);
    color: var(--color-success);
  }

  .note-src-other {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
  }

  .note-content {
    font-size: var(--text-sm);
    color: var(--color-text);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    margin-bottom: var(--space-2);
  }

  .tag-static { cursor: default; }

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

  /* Empty + skeleton (shared) */
  .empty-state {
    padding: 40px 16px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: center;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .skeleton {
    background: linear-gradient(90deg, var(--color-surface-2) 0%, var(--color-bg-card) 50%, var(--color-surface-2) 100%);
    background-size: 200% 100%;
    animation: skel 1.4s ease-in-out infinite;
  }

  @keyframes skel {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
</style>
