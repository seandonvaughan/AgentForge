<script lang="ts">
  interface SearchResult {
    id?: string;
    content: string;
    score: number; // 0-1 similarity
    metadata?: Record<string, unknown>;
    type?: string;
    source?: string;
  }

  const ALL_TYPES = ['session', 'agent', 'cycle', 'sprint', 'memory'] as const;
  type ContentType = typeof ALL_TYPES[number];

  // Map content types to their dashboard navigation paths.
  const TYPE_ROUTES: Record<string, string> = {
    session: '/sessions',
    agent:   '/agents',
    cycle:   '/cycles',
    sprint:  '/sprints',
    memory:  '/memory',
  };

  let query = $state('');
  let results = $state<SearchResult[]>([]);
  let searching = $state(false);
  let error = $state<string | null>(null);
  let searched = $state(false);
  // Empty array = all types (no filter). Populated = include only selected types.
  let selectedTypes = $state<ContentType[]>([]);

  async function search() {
    if (!query.trim()) return;
    searching = true;
    error = null;
    searched = true;
    results = [];
    try {
      const body: { query: string; limit: number; types?: string[] } = {
        query: query.trim(),
        limit: 20,
      };
      if (selectedTypes.length > 0) body.types = selectedTypes;

      const res = await fetch('/api/v5/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      results = json.data ?? json.results ?? json ?? [];
    } catch (e) {
      error = String(e);
    } finally {
      searching = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') search();
  }

  function toggleType(t: ContentType) {
    if (selectedTypes.includes(t)) {
      selectedTypes = selectedTypes.filter(s => s !== t);
    } else {
      selectedTypes = [...selectedTypes, t];
    }
  }

  function scoreColor(score: number): string {
    if (score >= 0.85) return 'var(--color-success)';
    if (score >= 0.65) return 'var(--color-warning)';
    return 'var(--color-text-faint)';
  }

  function contentPreview(text: string): string {
    return text.length > 280 ? text.slice(0, 278) + '…' : text;
  }

  /** Return the dashboard route for a result, or null if none exists. */
  function resultHref(result: SearchResult): string | null {
    if (!result.type) return null;
    return TYPE_ROUTES[result.type] ?? null;
  }
</script>

<svelte:head><title>Search — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Search</h1>
    <p class="page-subtitle">Search across agent memory, sessions, cycles, and sprints</p>
  </div>
</div>

<div class="search-bar">
  <input
    class="search-input"
    type="search"
    placeholder="Search agents, sessions, cycles, sprints…"
    bind:value={query}
    onkeydown={handleKeydown}
    aria-label="Search query"
    disabled={searching}
    autofocus
  />
  <button
    class="btn btn-primary"
    onclick={search}
    disabled={searching || !query.trim()}
  >
    {searching ? 'Searching…' : 'Search'}
  </button>
</div>

<!-- Type filters -->
<div class="type-filters" role="group" aria-label="Filter by type">
  <span class="filter-label">Filter by type:</span>
  {#each ALL_TYPES as t}
    <button
      class="type-chip"
      class:active={selectedTypes.includes(t)}
      onclick={() => toggleType(t)}
      aria-pressed={selectedTypes.includes(t)}
    >
      {t}
    </button>
  {/each}
  {#if selectedTypes.length > 0}
    <button class="type-chip clear-chip" onclick={() => (selectedTypes = [])}>
      clear filter
    </button>
  {/if}
</div>

{#if searching}
  <div style="display: flex; flex-direction: column; gap: var(--space-3);">
    {#each Array(5) as _}
      <div class="card result-card-skeleton">
        <div class="skeleton" style="height: 14px; width: 30%; margin-bottom: var(--space-2);"></div>
        <div class="skeleton" style="height: 12px; width: 100%; margin-bottom: var(--space-1);"></div>
        <div class="skeleton" style="height: 12px; width: 75%;"></div>
      </div>
    {/each}
  </div>
{:else if error}
  <div class="empty-state">
    Search failed: {error}
    <button class="btn btn-ghost btn-sm" style="margin-top: var(--space-3)" onclick={search}>Retry</button>
  </div>
{:else if searched && results.length === 0}
  <div class="empty-state">No results found for "{query}".</div>
{:else if results.length > 0}
  <div class="results-header">
    <span>{results.length} results</span>
    <span class="results-query">"{query}"</span>
  </div>
  <div class="results-list">
    {#each results as result, i (result.id ?? i)}
      {@const href = resultHref(result)}
      <div class="card result-card" class:result-card-link={!!href}>
        <div class="result-header">
          <div class="result-meta">
            {#if result.type}
              {#if href}
                <a class="badge muted result-type-link" {href}>{result.type}</a>
              {:else}
                <span class="badge muted">{result.type}</span>
              {/if}
            {/if}
            {#if result.source}
              <span class="result-source">{result.source}</span>
            {/if}
          </div>
          <span class="score-badge" style="color: {scoreColor(result.score)};">
            {Math.round(result.score * 100)}% match
          </span>
        </div>
        <div class="score-bar-track">
          <div class="score-bar-fill" style="width: {Math.round(result.score * 100)}%; background: {scoreColor(result.score)};"></div>
        </div>
        <p class="result-content">{contentPreview(result.content)}</p>
        {#if result.metadata && Object.keys(result.metadata).length > 0}
          <div class="result-metadata">
            {#each Object.entries(result.metadata).slice(0, 4) as [k, v]}
              <span class="meta-pair"><span class="meta-key">{k}:</span> {String(v)}</span>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{:else}
  <div class="empty-state search-hint">
    <p>Enter a search query to find content across agents, sessions, cycles, and sprints.</p>
    <div class="hint-examples">
      <span class="hint-label">Try:</span>
      {#each ['sprint', 'agent', 'cycle', 'memory', 'completed'] as ex}
        <button class="type-chip" onclick={() => { query = ex; search(); }}>{ex}</button>
      {/each}
    </div>
  </div>
{/if}

<style>
  .search-bar {
    display: flex;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }
  .search-input {
    flex: 1;
    padding: var(--space-3) var(--space-4);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: var(--text-md);
    outline: none;
  }
  .search-input:focus { border-color: var(--color-brand); box-shadow: 0 0 0 2px rgba(91,138,245,0.15); }

  .type-filters {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-6);
  }
  .filter-label {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-right: var(--space-1);
  }
  .type-chip {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    cursor: pointer;
    border: 1px solid var(--color-border);
    background: var(--color-surface-2);
    color: var(--color-text-muted);
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .type-chip:hover { border-color: var(--color-brand); color: var(--color-text); }
  .type-chip.active {
    background: var(--color-brand);
    border-color: var(--color-brand);
    color: #fff;
  }
  .clear-chip { color: var(--color-text-faint); border-style: dashed; }

  .results-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }
  .results-query {
    font-style: italic;
    color: var(--color-text-faint);
  }
  .results-list { display: flex; flex-direction: column; gap: var(--space-3); }
  .result-card { cursor: default; }
  /* Cards with navigable type badges get a subtle hover highlight */
  .result-card-link:hover { border-color: var(--color-brand); }
  .result-type-link {
    text-decoration: none;
    cursor: pointer;
  }
  .result-type-link:hover { opacity: 0.8; text-decoration: underline; }
  .result-card-skeleton { padding: var(--space-4); }
  .result-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-2);
  }
  .result-meta { display: flex; align-items: center; gap: var(--space-2); }
  .result-source {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    font-family: var(--font-mono);
  }
  .score-badge {
    font-size: var(--text-xs);
    font-weight: 700;
    font-family: var(--font-mono);
  }
  .score-bar-track {
    height: 3px;
    background: var(--color-surface-3);
    border-radius: var(--radius-full);
    overflow: hidden;
    margin-bottom: var(--space-3);
  }
  .score-bar-fill {
    height: 100%;
    border-radius: var(--radius-full);
    transition: width 0.3s ease;
  }
  .result-content {
    font-size: var(--text-sm);
    color: var(--color-text);
    line-height: 1.6;
    margin: 0 0 var(--space-2);
  }
  .result-metadata {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    margin-top: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--color-border);
  }
  .meta-pair { font-size: var(--text-xs); color: var(--color-text-muted); }
  .meta-key { color: var(--color-text-faint); }
  .search-hint { font-style: italic; }
  .search-hint p { margin: 0 0 var(--space-3); }
  .hint-examples {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    font-style: normal;
  }
  .hint-label {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
</style>
