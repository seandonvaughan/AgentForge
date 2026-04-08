<script lang="ts">
  interface SearchResult {
    id?: string;
    content: string;
    score: number; // 0-1 similarity
    metadata?: Record<string, unknown>;
    type?: string;
    source?: string;
  }

  let query = '';
  let results: SearchResult[] = [];
  let searching = false;
  let error: string | null = null;
  let searched = false;

  async function search() {
    if (!query.trim()) return;
    searching = true;
    error = null;
    searched = true;
    results = [];
    try {
      const res = await fetch('/api/v5/embeddings/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), limit: 20 }),
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

  function scoreColor(score: number): string {
    if (score >= 0.85) return 'var(--color-success)';
    if (score >= 0.65) return 'var(--color-warning)';
    return 'var(--color-text-faint)';
  }

  function contentPreview(text: string): string {
    return text.length > 280 ? text.slice(0, 278) + '…' : text;
  }
</script>

<svelte:head><title>Search — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Search</h1>
    <p class="page-subtitle">Semantic search across agent memory and sessions</p>
  </div>
</div>

<div class="search-bar">
  <input
    class="search-input"
    type="search"
    placeholder="Search by meaning, not just keywords…"
    bind:value={query}
    on:keydown={handleKeydown}
    aria-label="Search query"
    disabled={searching}
  />
  <button
    class="btn btn-primary"
    onclick={search}
    disabled={searching || !query.trim()}
  >
    {searching ? 'Searching…' : 'Search'}
  </button>
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
      <div class="card result-card">
        <div class="result-header">
          <div class="result-meta">
            {#if result.type}
              <span class="badge muted">{result.type}</span>
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
    Enter a search query to find semantically similar content across agents, memory, and sessions.
  </div>
{/if}

<style>
  .search-bar {
    display: flex;
    gap: var(--space-3);
    margin-bottom: var(--space-6);
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
</style>
