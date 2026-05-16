<script lang="ts">
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';
  import type { KbDocSSR } from './+page.server.js';
  import { Card, Badge, Btn } from '$lib/components/v2';

  let { data }: { data: PageData } = $props();

  const kb = $derived(data.kb);
  let docs: KbDocSSR[] = $state(data.docs ?? []);
  let error: string | null = $state(data.error);

  // Create doc form
  let showCreate = $state(false);
  let formSlug = $state('');
  let formTitle = $state('');
  let formBody = $state('');
  let formAuthor = $state('user');
  let formCommit = $state('initial version');
  let submitting = $state(false);
  let formError: string | null = $state(null);

  async function refresh(): Promise<void> {
    if (!kb) return;
    try {
      const res = await fetch(`/api/v5/kbs/${kb.id}/docs`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data: KbDocSSR[] };
      docs = json.data;
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load docs';
    }
  }

  async function submitDoc(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!kb) return;
    if (!formSlug.trim() || !formTitle.trim() || !formBody.trim() || !formAuthor.trim()) {
      formError = 'slug, title, body, and authoredBy are required';
      return;
    }
    submitting = true;
    formError = null;
    try {
      const res = await fetch(`/api/v5/kbs/${kb.id}/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: formSlug.trim(),
          title: formTitle.trim(),
          bodyMd: formBody,
          authoredBy: formAuthor.trim(),
          commitMessage: formCommit.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      showCreate = false;
      formSlug = '';
      formTitle = '';
      formBody = '';
      formCommit = 'initial version';
      await refresh();
    } catch (err) {
      formError = err instanceof Error ? err.message : 'create failed';
    } finally {
      submitting = false;
    }
  }

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
        <a href="/knowledge/kbs">KBs</a> / {kb?.slug ?? 'unknown'}
      </div>
      <h1 class="page-title">
        {kb?.title ?? 'KB not found'}
        {#if kb}
          <Badge
            variant={kb.visibility === 'private' ? 'warning' : kb.visibility === 'public' ? 'success' : 'info'}
          >
            {kb.visibility}
          </Badge>
        {/if}
      </h1>
      {#if kb?.description}
        <p class="page-sub">{kb.description}</p>
      {/if}
    </div>
    <div>
      {#if kb}
        <Btn size="sm" onclick={() => (showCreate = !showCreate)}>
          {showCreate ? 'Cancel' : 'New Doc'}
        </Btn>
      {/if}
    </div>
  </div>

  {#if error}
    <Card>
      <div class="state-center">
        <span style="font-size:22px;color:var(--af-danger)">&#9888;</span>
        <span style="font-size:12px;color:var(--af-danger);margin-top:6px">{error}</span>
      </div>
    </Card>
  {/if}

  {#if showCreate && kb}
    <Card>
      <form class="create-form" onsubmit={submitDoc}>
        <h3 class="form-h3">New Document</h3>
        <div class="form-grid">
          <label class="field">
            <span>Slug</span>
            <input class="input font-mono" type="text" bind:value={formSlug} required />
          </label>
          <label class="field">
            <span>Title</span>
            <input class="input" type="text" bind:value={formTitle} required />
          </label>
          <label class="field full">
            <span>Body (markdown)</span>
            <textarea class="input" rows="10" bind:value={formBody}></textarea>
          </label>
          <label class="field">
            <span>Author</span>
            <input class="input font-mono" type="text" bind:value={formAuthor} required />
          </label>
          <label class="field">
            <span>Commit message</span>
            <input class="input" type="text" bind:value={formCommit} />
          </label>
        </div>
        {#if formError}
          <div class="form-error">{formError}</div>
        {/if}
        <div class="form-actions">
          <Btn type="submit" disabled={submitting}>{submitting ? 'Creating...' : 'Create'}</Btn>
        </div>
      </form>
    </Card>
  {/if}

  {#if kb}
    {#if docs.length === 0}
      <Card>
        <div class="state-center">
          <span style="font-size:28px;color:var(--af-faint)">&#128196;</span>
          <div style="font-size:13px;color:var(--af-text);font-weight:600;margin-top:8px">
            No documents yet.
          </div>
          <div style="font-size:11px;color:var(--af-dim);margin-top:4px">
            Click "New Doc" to add the first one.
          </div>
        </div>
      </Card>
    {:else}
      <div class="docs">
        {#each docs as doc (doc.id)}
          <Card>
            <button
              class="doc-card-btn"
              onclick={() => void goto(`/knowledge/kbs/${kb.slug}/${doc.slug}`)}
            >
              <div class="doc-head">
                <h3 class="doc-title">{doc.title}</h3>
                <span class="doc-ver font-mono">v{doc.currentVersion ?? 1}</span>
              </div>
              <div class="doc-slug font-mono">{doc.slug}</div>
              <div class="doc-meta">
                <span class="doc-meta-pair">
                  <span class="doc-meta-label">UPDATED</span>
                  <span class="doc-meta-val font-mono">{fmt(doc.updatedAt)}</span>
                </span>
              </div>
            </button>
          </Card>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 12px; padding: 20px 24px; max-width: 1200px; }
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
  .page-sub { margin: 4px 0 0; font-size: 12px; color: var(--af-dim); }
  .create-form { padding: 4px 4px 12px; }
  .form-h3 {
    margin: 0 0 12px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--af-dim);
  }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--af-dim); }
  .field.full { grid-column: span 2; }
  .input {
    background: var(--af-surface);
    border: 1px solid var(--af-border);
    color: var(--af-text);
    padding: 6px 10px;
    font-size: 12px;
    border-radius: 6px;
    font-family: inherit;
  }
  textarea.input { font-family: var(--af-font-mono); }
  .form-error { margin-top: 10px; color: var(--af-danger); font-size: 11px; }
  .form-actions { margin-top: 12px; display: flex; gap: 8px; }
  .docs { display: flex; flex-direction: column; gap: 10px; }
  .doc-card-btn {
    width: 100%;
    background: none;
    border: none;
    color: inherit;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
    padding: 0;
  }
  .doc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .doc-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--af-text); }
  .doc-ver {
    font-size: 11px;
    background: var(--af-surface2);
    color: var(--af-muted);
    padding: 2px 8px;
    border-radius: 999px;
  }
  .doc-slug { font-size: 10px; color: var(--af-faint); margin-top: 2px; margin-bottom: 8px; }
  .doc-meta { display: flex; gap: 16px; padding-top: 10px; border-top: 1px solid var(--af-border); }
  .doc-meta-pair { display: flex; flex-direction: column; gap: 2px; }
  .doc-meta-label { font-size: 9px; color: var(--af-faint); letter-spacing: 0.06em; }
  .doc-meta-val { font-size: 11px; color: var(--af-text); font-weight: 600; }
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
