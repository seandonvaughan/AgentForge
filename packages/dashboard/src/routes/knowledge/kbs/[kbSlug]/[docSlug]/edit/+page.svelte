<script lang="ts">
  import { goto } from '$app/navigation';
  import { marked } from 'marked';
  import type { PageData } from './$types';
  import { Card, Btn } from '$lib/components/v2';

  let { data }: { data: PageData } = $props();

  const kb = $derived(data.kb);
  const doc = $derived(data.doc);
  const loadError = $derived(data.error);

  let body = $state(data.doc?.body?.bodyMd ?? '');
  let title = $state(data.doc?.title ?? '');
  let author = $state('user');
  let commit = $state('');
  let submitting = $state(false);
  let formError: string | null = $state(null);

  const preview = $derived.by(() => {
    if (!body) return '<p class="empty-preview">Preview will appear here.</p>';
    const result = marked.parse(body, { async: false });
    return typeof result === 'string' ? result : '';
  });

  async function save(): Promise<void> {
    if (!kb || !doc) return;
    if (!body.trim() || !author.trim()) {
      formError = 'body and authoredBy are required';
      return;
    }
    submitting = true;
    formError = null;
    try {
      const res = await fetch(`/api/v5/kbs/${kb.id}/docs/${doc.slug}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bodyMd: body,
          authoredBy: author.trim(),
          commitMessage: commit.trim() || undefined,
          title: title.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      await goto(`/knowledge/kbs/${kb.slug}/${doc.slug}`);
    } catch (err) {
      formError = err instanceof Error ? err.message : 'save failed';
    } finally {
      submitting = false;
    }
  }
</script>

<div class="page">
  <div class="page-header">
    <div>
      <div class="crumbs">
        <a href="/knowledge/kbs">KBs</a> /
        <a href={`/knowledge/kbs/${kb?.slug ?? ''}`}>{kb?.slug ?? '...'}</a>
        /
        <a href={`/knowledge/kbs/${kb?.slug ?? ''}/${doc?.slug ?? ''}`}>{doc?.slug ?? '...'}</a>
        / edit
      </div>
      <h1 class="page-title">Edit {doc?.title ?? '...'}</h1>
      <p class="page-sub">
        Saving creates a new version. The previous body is preserved in history.
      </p>
    </div>
    <div class="actions">
      <Btn size="sm" onClick={() => void goto(`/knowledge/kbs/${kb?.slug}/${doc?.slug}`)}>
        Cancel
      </Btn>
      <Btn size="sm" variant="primary" onClick={save} disabled={submitting}>
        {submitting ? 'Saving...' : 'Save new version'}
      </Btn>
    </div>
  </div>

  {#if loadError}
    <Card>
      <div style="padding:20px;color:var(--af-danger);font-size:12px">{loadError}</div>
    </Card>
  {/if}

  {#if doc}
    <Card>
      <div class="meta-row">
        <label class="field">
          <span>Title</span>
          <input class="input" type="text" bind:value={title} />
        </label>
        <label class="field">
          <span>Author</span>
          <input class="input font-mono" type="text" bind:value={author} required />
        </label>
        <label class="field grow">
          <span>Commit message</span>
          <input
            class="input"
            type="text"
            bind:value={commit}
            placeholder="e.g. fixed typo, rewrote section 3"
          />
        </label>
      </div>
      {#if formError}
        <div class="form-error">{formError}</div>
      {/if}
    </Card>

    <div class="split">
      <Card style="display:flex;flex-direction:column;height:600px">
        <div class="pane-header">EDITOR (markdown)</div>
        <textarea class="md-textarea" bind:value={body}></textarea>
      </Card>
      <Card style="display:flex;flex-direction:column;height:600px">
        <div class="pane-header">PREVIEW</div>
        <article class="md-preview">{@html preview}</article>
      </Card>
    </div>
  {/if}
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 12px; padding: 20px 24px; max-width: 1400px; }
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
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
  .page-title { margin: 0; font-size: 20px; font-weight: 700; color: var(--af-text); }
  .page-sub { margin: 4px 0 0; font-size: 12px; color: var(--af-dim); }
  .actions { display: flex; gap: 8px; }
  .meta-row { display: flex; gap: 12px; flex-wrap: wrap; }
  .field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--af-dim); }
  .field.grow { flex: 1; min-width: 220px; }
  .input {
    background: var(--af-surface);
    border: 1px solid var(--af-border);
    color: var(--af-text);
    padding: 6px 10px;
    font-size: 12px;
    border-radius: 6px;
    font-family: inherit;
    width: 100%;
  }
  .form-error { margin-top: 10px; color: var(--af-danger); font-size: 11px; }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .pane-header {
    font-size: 10px;
    color: var(--af-faint);
    letter-spacing: 0.06em;
    margin-bottom: 8px;
  }
  .md-textarea {
    flex: 1;
    background: var(--af-surface);
    border: 1px solid var(--af-border);
    border-radius: 6px;
    padding: 10px;
    color: var(--af-text);
    font-family: var(--af-font-mono);
    font-size: 12px;
    line-height: 1.6;
    resize: none;
    width: 100%;
  }
  .md-preview {
    flex: 1;
    overflow-y: auto;
    padding: 4px;
    font-size: 13px;
    color: var(--af-text);
    line-height: 1.6;
  }
  .md-preview :global(.empty-preview) { color: var(--af-faint); font-style: italic; }
  .md-preview :global(h1),
  .md-preview :global(h2),
  .md-preview :global(h3) { color: var(--af-text); font-weight: 700; margin: 1em 0 0.4em; }
  .md-preview :global(h1) { font-size: 18px; }
  .md-preview :global(h2) { font-size: 15px; }
  .md-preview :global(p) { margin: 0.6em 0; color: var(--af-muted); }
  .md-preview :global(ul),
  .md-preview :global(ol) { padding-left: 22px; color: var(--af-muted); }
  .md-preview :global(code) {
    background: var(--af-surface2);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.92em;
    font-family: var(--af-font-mono);
  }
  .md-preview :global(pre) {
    background: var(--af-surface2);
    padding: 10px;
    border-radius: 6px;
    overflow-x: auto;
  }
  .font-mono { font-family: var(--af-font-mono); font-feature-settings: 'tnum' 1; }
  @media (max-width: 800px) {
    .split { grid-template-columns: 1fr; }
  }
</style>
