<script lang="ts">
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';
  import type { KbDocVersionSSR } from '../+page.server.js';
  import { Card, Btn, Badge } from '$lib/components/v2';

  let { data }: { data: PageData } = $props();

  const kb = $derived(data.kb);
  const doc = $derived(data.doc);
  const versions: KbDocVersionSSR[] = $derived(data.versions ?? []);
  const error = $derived(data.error);

  // Selection: two versions for diff. Default: latest two if present.
  let leftVer: number | null = $state(versions.length >= 2 ? versions[1]?.version ?? null : null);
  let rightVer: number | null = $state(versions.length >= 1 ? versions[0]?.version ?? null : null);
  let restoreError: string | null = $state(null);
  let restoring = $state(false);

  const leftVersion = $derived(versions.find((v) => v.version === leftVer) ?? null);
  const rightVersion = $derived(versions.find((v) => v.version === rightVer) ?? null);

  /**
   * Tiny LCS-based line-level diff. Sufficient for KB doc bodies (rarely
   * thousands of lines). Returns an array of segments tagged `same | add | del`.
   */
  type DiffSegment = { kind: 'same' | 'add' | 'del'; left: string | null; right: string | null };

  function diffLines(a: string, b: string): DiffSegment[] {
    const aLines = a.split('\n');
    const bLines = b.split('\n');
    const n = aLines.length;
    const m = bLines.length;

    // LCS DP table.
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (aLines[i] === bLines[j]) {
          dp[i]![j] = (dp[i + 1]?.[j + 1] ?? 0) + 1;
        } else {
          dp[i]![j] = Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
        }
      }
    }

    const out: DiffSegment[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (aLines[i] === bLines[j]) {
        out.push({ kind: 'same', left: aLines[i] ?? null, right: bLines[j] ?? null });
        i++;
        j++;
      } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
        out.push({ kind: 'del', left: aLines[i] ?? null, right: null });
        i++;
      } else {
        out.push({ kind: 'add', left: null, right: bLines[j] ?? null });
        j++;
      }
    }
    while (i < n) {
      out.push({ kind: 'del', left: aLines[i] ?? null, right: null });
      i++;
    }
    while (j < m) {
      out.push({ kind: 'add', left: null, right: bLines[j] ?? null });
      j++;
    }
    return out;
  }

  const diff = $derived.by(() => {
    if (!leftVersion || !rightVersion) return [] as DiffSegment[];
    return diffLines(leftVersion.bodyMd, rightVersion.bodyMd);
  });

  async function restoreVersion(v: KbDocVersionSSR): Promise<void> {
    if (!kb || !doc) return;
    if (!confirm(`Restore version ${v.version} as a new version? The current head will be preserved in history.`)) {
      return;
    }
    restoring = true;
    restoreError = null;
    try {
      const res = await fetch(`/api/v5/kbs/${kb.id}/docs/${doc.slug}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bodyMd: v.bodyMd,
          authoredBy: 'user',
          commitMessage: `restored from v${v.version}`,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      await goto(`/knowledge/kbs/${kb.slug}/${doc.slug}`);
    } catch (e) {
      restoreError = e instanceof Error ? e.message : 'restore failed';
    } finally {
      restoring = false;
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
        <a href="/knowledge/kbs">KBs</a> /
        <a href={`/knowledge/kbs/${kb?.slug ?? ''}`}>{kb?.slug ?? '...'}</a>
        /
        <a href={`/knowledge/kbs/${kb?.slug ?? ''}/${doc?.slug ?? ''}`}>{doc?.slug ?? '...'}</a>
        / history
      </div>
      <h1 class="page-title">History — {doc?.title ?? '...'}</h1>
      <p class="page-sub">
        <span class="font-mono">{versions.length}</span> version{versions.length === 1 ? '' : 's'}.
        Pick any two to diff. Click "Restore" to create a new version with the old body.
      </p>
    </div>
    <Btn size="sm" onclick={() => void goto(`/knowledge/kbs/${kb?.slug}/${doc?.slug}`)}>
      Back to doc
    </Btn>
  </div>

  {#if error}
    <Card>
      <div style="padding:20px;color:var(--af-danger);font-size:12px">{error}</div>
    </Card>
  {/if}

  {#if restoreError}
    <Card>
      <div style="padding:14px;color:var(--af-danger);font-size:12px">{restoreError}</div>
    </Card>
  {/if}

  {#if versions.length > 0}
    <Card noPad>
      <table class="vtable">
        <thead>
          <tr>
            <th>Version</th>
            <th>Author</th>
            <th>Authored</th>
            <th>Commit</th>
            <th>Diff (left/right)</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each versions as v (v.id)}
            <tr>
              <td class="cell-v">
                <Badge variant={v.version === versions[0]?.version ? 'success' : 'info'}>
                  v{v.version}
                </Badge>
                {#if v.version === versions[0]?.version}<span class="head-tag">HEAD</span>{/if}
              </td>
              <td class="font-mono">{v.authoredBy}</td>
              <td class="font-mono">{fmt(v.authoredAt)}</td>
              <td class="commit-cell">{v.commitMessage ?? '—'}</td>
              <td>
                <label class="diff-pick">
                  <input
                    type="radio"
                    name="left"
                    value={v.version}
                    bind:group={leftVer}
                  />
                  L
                </label>
                <label class="diff-pick">
                  <input
                    type="radio"
                    name="right"
                    value={v.version}
                    bind:group={rightVer}
                  />
                  R
                </label>
              </td>
              <td>
                <Btn
                  size="sm"
                  onclick={() => void restoreVersion(v)}
                  disabled={restoring || v.version === versions[0]?.version}
                >
                  Restore
                </Btn>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </Card>

    {#if leftVersion && rightVersion && leftVer !== rightVer}
      <Card>
        <div class="diff-header">
          Diff: <span class="font-mono">v{leftVersion.version}</span>
          → <span class="font-mono">v{rightVersion.version}</span>
        </div>
        <div class="diff-view">
          {#each diff as seg, i (i)}
            <div
              class="diff-row"
              class:diff-same={seg.kind === 'same'}
              class:diff-add={seg.kind === 'add'}
              class:diff-del={seg.kind === 'del'}
            >
              <div class="diff-left">
                {#if seg.left !== null}<span class="mark">{seg.kind === 'del' ? '-' : ' '}</span>{seg.left}{/if}
              </div>
              <div class="diff-right">
                {#if seg.right !== null}<span class="mark">{seg.kind === 'add' ? '+' : ' '}</span>{seg.right}{/if}
              </div>
            </div>
          {/each}
        </div>
      </Card>
    {/if}
  {:else}
    <Card>
      <div style="padding:30px;text-align:center;color:var(--af-dim);font-size:12px">
        No versions to show.
      </div>
    </Card>
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
  .vtable {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    color: var(--af-text);
  }
  .vtable th {
    text-align: left;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--af-faint);
    padding: 10px 14px;
    border-bottom: 1px solid var(--af-border);
  }
  .vtable td {
    padding: 10px 14px;
    border-bottom: 1px solid var(--af-border);
    vertical-align: middle;
  }
  .vtable tbody tr:hover { background: var(--af-surface); }
  .cell-v { display: flex; align-items: center; gap: 6px; }
  .head-tag {
    font-size: 9px;
    color: var(--af-purple);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .commit-cell { color: var(--af-muted); font-style: italic; max-width: 280px; }
  .diff-pick {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
    color: var(--af-muted);
    margin-right: 8px;
  }
  .diff-header {
    font-size: 12px;
    color: var(--af-dim);
    margin-bottom: 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--af-border);
  }
  .diff-view {
    display: flex;
    flex-direction: column;
    font-family: var(--af-font-mono);
    font-size: 12px;
    background: var(--af-surface);
    border-radius: 6px;
    overflow-x: auto;
    max-height: 600px;
    overflow-y: auto;
  }
  .diff-row { display: grid; grid-template-columns: 1fr 1fr; min-height: 18px; }
  .diff-left,
  .diff-right {
    padding: 2px 8px;
    white-space: pre-wrap;
    word-break: break-word;
    border-right: 1px solid var(--af-border2);
  }
  .diff-right { border-right: none; }
  .diff-same .diff-left,
  .diff-same .diff-right { color: var(--af-muted); }
  .diff-add .diff-right { background: color-mix(in srgb, var(--af-success) 12%, transparent); color: var(--af-text); }
  .diff-add .diff-left { background: var(--af-surface); }
  .diff-del .diff-left { background: color-mix(in srgb, var(--af-danger) 12%, transparent); color: var(--af-text); }
  .diff-del .diff-right { background: var(--af-surface); }
  .mark { color: var(--af-faint); padding-right: 4px; }
  .font-mono { font-family: var(--af-font-mono); font-feature-settings: 'tnum' 1; }
</style>
