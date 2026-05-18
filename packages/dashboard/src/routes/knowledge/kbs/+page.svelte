<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';
  import type { KbSSR, KbVisibility } from './+page.server.js';
  import { Card, Badge, Btn } from '$lib/components/v2';

  let { data }: { data: PageData } = $props();

  let kbs: KbSSR[] = $state(data.data ?? []);
  let loading = $state(kbs.length === 0);
  let error: string | null = $state(null);

  // Create form
  let showCreate = $state(false);
  let formSlug = $state('');
  let formTitle = $state('');
  let formDescription = $state('');
  let formOwner = $state('user');
  let formVisibility: KbVisibility = $state('workspace');
  let submitting = $state(false);
  let formError: string | null = $state(null);

  // Per-KB doc counts (lazy fetched once)
  let docCounts: Record<string, number> = $state({});

  async function loadKbs(): Promise<void> {
    try {
      const res = await fetch('/api/v5/kbs?limit=200');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data: KbSSR[] };
      kbs = json.data;
      error = null;
      // Fire-and-forget per-KB doc count fetches.
      for (const kb of kbs) void loadDocCount(kb.id);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load KBs';
    } finally {
      loading = false;
    }
  }

  async function loadDocCount(kbId: string): Promise<void> {
    try {
      const res = await fetch(`/api/v5/kbs/${kbId}`);
      if (!res.ok) return;
      const json = (await res.json()) as { meta: { docCount: number } };
      docCounts = { ...docCounts, [kbId]: json.meta.docCount };
    } catch {
      // best-effort, surface a 0 fallback
    }
  }

  async function submitCreate(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!formSlug.trim() || !formTitle.trim() || !formOwner.trim()) {
      formError = 'slug, title, and owner are required';
      return;
    }
    submitting = true;
    formError = null;
    try {
      const res = await fetch('/api/v5/kbs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: formSlug.trim(),
          title: formTitle.trim(),
          description: formDescription.trim() || undefined,
          owner: formOwner.trim(),
          visibility: formVisibility,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      showCreate = false;
      formSlug = '';
      formTitle = '';
      formDescription = '';
      formDescription = '';
      await loadKbs();
    } catch (err) {
      formError = err instanceof Error ? err.message : 'create failed';
    } finally {
      submitting = false;
    }
  }

  function visibilityVariant(v: KbVisibility): 'info' | 'warning' | 'success' {
    if (v === 'private') return 'warning';
    if (v === 'public') return 'success';
    return 'info';
  }

  function fmt(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString();
    } catch {
      return iso;
    }
  }

  onMount(() => {
    if (kbs.length === 0) void loadKbs();
    else for (const kb of kbs) void loadDocCount(kb.id);
  });
</script>

<div class="page">
  <div class="page-header">
    <div>
      <div class="crumbs">Workspace / Knowledge / KBs</div>
      <h1 class="page-title">Knowledge Bases</h1>
      <p class="page-sub">
        SharePoint-style versioned doc collections. <span class="font-mono">{kbs.length}</span> KB{kbs.length === 1 ? '' : 's'}.
      </p>
    </div>
    <div>
      <Btn size="sm" onClick={() => (showCreate = !showCreate)}>
        {showCreate ? 'Cancel' : 'New KB'}
      </Btn>
    </div>
  </div>

  {#if showCreate}
    <Card>
      <form class="create-form" onsubmit={submitCreate}>
        <h3 class="form-h3">Create Knowledge Base</h3>
        <div class="form-grid">
          <label class="field">
            <span>Slug</span>
            <input
              class="input font-mono"
              type="text"
              bind:value={formSlug}
              placeholder="gate-rubric"
              required
            />
          </label>
          <label class="field">
            <span>Title</span>
            <input class="input" type="text" bind:value={formTitle} required />
          </label>
          <label class="field full">
            <span>Description</span>
            <input class="input" type="text" bind:value={formDescription} />
          </label>
          <label class="field">
            <span>Owner</span>
            <input class="input font-mono" type="text" bind:value={formOwner} required />
          </label>
          <label class="field">
            <span>Visibility</span>
            <select class="input" bind:value={formVisibility}>
              <option value="private">private</option>
              <option value="workspace">workspace</option>
              <option value="public">public</option>
            </select>
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

  {#if loading}
    <Card>
      <div class="state-center">
        <div class="spinner"></div>
      </div>
    </Card>
  {:else if error}
    <Card>
      <div class="state-center">
        <span style="font-size:22px;color:var(--af-danger)">&#9888;</span>
        <span style="font-size:12px;color:var(--af-danger);margin-top:6px">{error}</span>
      </div>
    </Card>
  {:else if kbs.length === 0}
    <Card>
      <div class="state-center">
        <span style="font-size:28px;color:var(--af-faint)">&#128218;</span>
        <div style="font-size:13px;color:var(--af-text);font-weight:600;margin-top:8px">
          No KBs yet.
        </div>
        <div style="font-size:11px;color:var(--af-dim);margin-top:4px">
          Create one to start collecting versioned documents.
        </div>
      </div>
    </Card>
  {:else}
    <div class="kb-grid">
      {#each kbs as kb (kb.id)}
        <Card>
          <button class="kb-card-btn" onclick={() => void goto(`/knowledge/kbs/${kb.slug}`)}>
            <div class="kb-head">
              <h3 class="kb-title">{kb.title}</h3>
              <Badge variant={visibilityVariant(kb.visibility)}>{kb.visibility}</Badge>
            </div>
            <div class="kb-slug font-mono">{kb.slug}</div>
            {#if kb.description}
              <p class="kb-desc">{kb.description}</p>
            {/if}
            <div class="kb-meta">
              <span class="kb-meta-pair">
                <span class="kb-meta-label">DOCS</span>
                <span class="kb-meta-val font-mono">{docCounts[kb.id] ?? '–'}</span>
              </span>
              <span class="kb-meta-pair">
                <span class="kb-meta-label">OWNER</span>
                <span class="kb-meta-val font-mono">{kb.owner}</span>
              </span>
              <span class="kb-meta-pair">
                <span class="kb-meta-label">UPDATED</span>
                <span class="kb-meta-val font-mono">{fmt(kb.updatedAt)}</span>
              </span>
            </div>
          </button>
        </Card>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 20px 24px;
    max-width: 1200px;
  }
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
  .page-title {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--af-text);
  }
  .page-sub {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--af-dim);
  }
  .create-form { padding: 4px 4px 12px; }
  .form-h3 {
    margin: 0 0 12px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--af-dim);
  }
  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
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
  .input:focus { outline: none; border-color: var(--af-purple); }
  .form-error {
    margin-top: 10px;
    color: var(--af-danger);
    font-size: 11px;
  }
  .form-actions { margin-top: 12px; display: flex; gap: 8px; }
  .kb-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 12px;
  }
  .kb-card-btn {
    width: 100%;
    background: none;
    border: none;
    color: inherit;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
    padding: 0;
  }
  .kb-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
  }
  .kb-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--af-text); }
  .kb-slug { font-size: 10px; color: var(--af-faint); margin-bottom: 8px; }
  .kb-desc { margin: 0 0 12px; font-size: 12px; color: var(--af-muted); line-height: 1.5; }
  .kb-meta {
    display: flex;
    gap: 16px;
    padding-top: 10px;
    border-top: 1px solid var(--af-border);
  }
  .kb-meta-pair { display: flex; flex-direction: column; gap: 2px; }
  .kb-meta-label { font-size: 9px; color: var(--af-faint); letter-spacing: 0.06em; }
  .kb-meta-val { font-size: 11px; color: var(--af-text); font-weight: 600; }
  .state-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 60px 20px;
    text-align: center;
  }
  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--af-border2);
    border-top-color: var(--af-purple);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .font-mono { font-family: var(--af-font-mono); font-feature-settings: 'tnum' 1; }
</style>
