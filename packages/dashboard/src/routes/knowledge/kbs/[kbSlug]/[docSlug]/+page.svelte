<script lang="ts">
  import { goto } from '$app/navigation';
  import { marked } from 'marked';
  import type { PageData } from './$types';
  import { Card, Badge, Btn } from '$lib/components/v2';

  let { data }: { data: PageData } = $props();

  const kb = $derived(data.kb);
  const doc = $derived(data.doc);
  const error = $derived(data.error);

  const renderedBody = $derived.by(() => {
    if (!doc?.body?.bodyMd) return '';
    // marked.parse can return string | Promise<string>. We use sync mode.
    const result = marked.parse(doc.body.bodyMd, { async: false });
    return typeof result === 'string' ? result : '';
  });

  function fmt(iso: string): string {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }
</script>

<div class="page">
  <div class="page-header">
    <div>
      <div class="crumbs">
        <a href="/knowledge/kbs">KBs</a> /
        <a href={`/knowledge/kbs/${kb?.slug ?? ''}`}>{kb?.slug ?? '...'}</a>
        / {doc?.slug ?? '...'}
      </div>
      <h1 class="page-title">
        {doc?.title ?? error ?? 'Doc'}
        {#if doc?.currentVersion != null}
          <span class="ver-badge font-mono">v{doc.currentVersion}</span>
        {/if}
      </h1>
      {#if doc?.body}
        <p class="page-sub">
          By <span class="font-mono">{doc.body.authoredBy}</span> · {fmt(doc.body.authoredAt)}
          {#if doc.body.commitMessage}
            · <span class="commit-msg">{doc.body.commitMessage}</span>
          {/if}
        </p>
      {/if}
    </div>
    {#if kb && doc}
      <div class="actions">
        <Btn
          size="sm"
          onClick={() => void goto(`/knowledge/kbs/${kb.slug}/${doc.slug}/history`)}
        >
          History
        </Btn>
        <Btn
          size="sm"
          variant="primary"
          onClick={() => void goto(`/knowledge/kbs/${kb.slug}/${doc.slug}/edit`)}
        >
          Edit
        </Btn>
      </div>
    {/if}
  </div>

  {#if error}
    <Card>
      <div class="state-center">
        <span style="font-size:22px;color:var(--af-danger)">&#9888;</span>
        <span style="font-size:12px;color:var(--af-danger);margin-top:6px">{error}</span>
      </div>
    </Card>
  {:else if !doc}
    <Card>
      <div class="state-center">
        <span style="font-size:28px;color:var(--af-faint)">&#128196;</span>
        <span style="font-size:12px;color:var(--af-dim);margin-top:6px">Loading...</span>
      </div>
    </Card>
  {:else}
    <Card>
      <article class="doc-rendered">{@html renderedBody}</article>
    </Card>
  {/if}
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 12px; padding: 20px 24px; max-width: 1000px; }
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 2px;
  }
  .crumbs {
    font-size: 10px;
    color: var(--af-faint);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .crumbs a { color: var(--af-faint); text-decoration: none; }
  .crumbs a:hover { color: var(--af-text); }
  .page-title {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--af-text);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ver-badge {
    font-size: 11px;
    background: var(--af-surface2);
    color: var(--af-muted);
    padding: 2px 10px;
    border-radius: 999px;
    font-weight: 600;
  }
  .page-sub { margin: 4px 0 0; font-size: 12px; color: var(--af-dim); }
  .commit-msg { color: var(--af-muted); font-style: italic; }
  .actions { display: flex; gap: 8px; }
  .doc-rendered {
    font-size: 14px;
    color: var(--af-text);
    line-height: 1.7;
    padding: 8px 4px;
  }
  .doc-rendered :global(h1),
  .doc-rendered :global(h2),
  .doc-rendered :global(h3) {
    color: var(--af-text);
    font-weight: 700;
    margin-top: 1.5em;
    margin-bottom: 0.5em;
  }
  .doc-rendered :global(h1) { font-size: 22px; }
  .doc-rendered :global(h2) { font-size: 18px; border-bottom: 1px solid var(--af-border); padding-bottom: 6px; }
  .doc-rendered :global(h3) { font-size: 15px; }
  .doc-rendered :global(p) { margin: 0.8em 0; color: var(--af-muted); }
  .doc-rendered :global(ul),
  .doc-rendered :global(ol) { padding-left: 24px; color: var(--af-muted); }
  .doc-rendered :global(li) { margin: 4px 0; }
  .doc-rendered :global(code) {
    font-family: var(--af-font-mono);
    background: var(--af-surface);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 0.92em;
  }
  .doc-rendered :global(pre) {
    background: var(--af-surface);
    padding: 12px;
    border-radius: 6px;
    overflow-x: auto;
    border: 1px solid var(--af-border);
  }
  .doc-rendered :global(pre code) { background: transparent; padding: 0; }
  .doc-rendered :global(blockquote) {
    border-left: 3px solid var(--af-purple);
    margin: 1em 0;
    padding: 4px 12px;
    color: var(--af-muted);
    background: var(--af-surface);
  }
  .doc-rendered :global(a) { color: var(--af-accent2); }
  .state-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 60px 20px;
    text-align: center;
  }
  .font-mono { font-family: var(--af-font-mono); font-feature-settings: 'tnum' 1; }
</style>
