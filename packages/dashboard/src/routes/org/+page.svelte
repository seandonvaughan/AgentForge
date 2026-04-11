<script lang="ts">
  import { onMount } from 'svelte';
  import type { PageData } from './$types';
  import type { OrgNodeData, OrgEdgeData } from './+page.server';

  let { data }: { data: PageData } = $props();

  interface OrgNode { id: string; label: string; model?: 'opus' | 'sonnet' | 'haiku'; }
  interface OrgEdge { from: string; to: string; }

  interface TreeNode extends OrgNode {
    children: TreeNode[];
    depth: number;
    /** IDs of direct delegates that were cut by cycle-prevention (already visited in this path). */
    cycleRefs?: string[];
  }

  // ── Reactive state — populated from server data by $effect.pre below ────────
  let roots: TreeNode[] = $state([]);
  let orphans: TreeNode[] = $state([]); // agents not in any delegation edge
  // loading=true until $effect.pre syncs server data (or onMount falls back to API)
  let loading = $state(true);
  let error: string | null = $state(null);
  let totalNodes = $state(0);
  let totalEdges = $state(0);
  let orphansCollapsed = $state(true);
  let collapsed: Set<string> = $state(new Set());

  // ── Sync server data into state before first render ────────────────────────
  // $effect.pre runs synchronously before each DOM update so SSR-provided data
  // is in place before the first paint (no loading flash). It also re-fires when
  // SvelteKit re-runs the server load (e.g. after invalidate()), keeping the tree
  // in sync. buildTree is a hoisted function declaration — available here.
  $effect.pre(() => {
    const nodes: OrgNode[] = (data.nodes as OrgNodeData[] as OrgNode[]) ?? [];
    const edges: OrgEdge[] = (data.edges as OrgEdgeData[] as OrgEdge[]) ?? [];

    if (nodes.length === 0) return; // no server data — onMount falls back to API

    const result = buildTree(nodes, edges);
    roots = result.roots;
    orphans = result.orphans;
    totalNodes = nodes.length;
    totalEdges = edges.length;

    // Auto-collapse branches at depth ≥ 3
    const set = new Set<string>();
    (function walk(ns: TreeNode[]) {
      for (const n of ns) {
        if (n.depth >= 3 && n.children.length > 0) set.add(n.id);
        walk(n.children);
      }
    })(result.roots);
    collapsed = set;
    loading = false;
  });

  const MODEL_COLORS: Record<string, string> = {
    opus: '#f5c842', sonnet: '#4a9eff', haiku: '#4caf82',
  };
  const MODEL_BG: Record<string, string> = {
    opus: 'rgba(245,200,66,0.08)', sonnet: 'rgba(74,158,255,0.08)', haiku: 'rgba(76,175,130,0.08)',
  };

  /**
   * Build a tree from nodes + edges.
   *
   * Key design decisions:
   * - Per-root visited sets: each root subtree is traversed independently, so an
   *   agent that is a delegate of multiple parents (e.g. "researcher") appears
   *   under EACH parent's branch rather than vanishing after the first visit.
   * - Cycle detection: a path-local `ancestorStack` prevents infinite loops when
   *   delegation cycles exist in the data (A→B→A).
   * - Orphans returned separately: agents with no delegation edges are included in
   *   a second list so operators can see the full roster, not just the hierarchy.
   */
  function buildTree(
    nodes: OrgNode[],
    edges: OrgEdge[],
  ): { roots: TreeNode[]; orphans: TreeNode[] } {
    const nodeMap = new Map<string, OrgNode>();
    nodes.forEach(n => nodeMap.set(n.id, n));

    const childrenOf = new Map<string, string[]>();
    const hasParent = new Set<string>();
    const inAnyEdge = new Set<string>();

    edges.forEach(e => {
      if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
      childrenOf.get(e.from)!.push(e.to);
      hasParent.add(e.to);
      inAnyEdge.add(e.from);
      inAnyEdge.add(e.to);
    });

    // Roots = nodes that appear in edges but have no parent
    const rootIds = [...inAnyEdge].filter(id => !hasParent.has(id));
    const priority: Record<string, number> = { ceo: 0, genesis: 1 };
    rootIds.sort((a, b) => (priority[a] ?? 99) - (priority[b] ?? 99) || a.localeCompare(b));

    const tierOrder: Record<string, number> = { opus: 0, sonnet: 1, haiku: 2 };

    /**
     * Recursively build a TreeNode.
     * @param ancestorStack - IDs of all ancestors in the current path (cycle guard).
     *   We do NOT share this across root traversals — each root gets a fresh stack.
     */
    function make(id: string, depth: number, ancestorStack: Set<string>): TreeNode | null {
      const node = nodeMap.get(id);
      if (!node) return null;

      // Cycle detection: if this id is already an ancestor in the current path, stop.
      if (ancestorStack.has(id)) return null;

      const nextStack = new Set(ancestorStack);
      nextStack.add(id);

      const childIds = childrenOf.get(id) ?? [];
      const children: TreeNode[] = [];
      const cycleRefs: string[] = [];

      for (const cid of childIds) {
        if (nextStack.has(cid)) {
          cycleRefs.push(cid);
        } else {
          const child = make(cid, depth + 1, nextStack);
          if (child) children.push(child);
        }
      }

      children.sort(
        (a, b) =>
          (tierOrder[a.model ?? ''] ?? 3) - (tierOrder[b.model ?? ''] ?? 3) ||
          a.label.localeCompare(b.label),
      );

      return {
        ...node,
        children,
        depth,
        ...(cycleRefs.length > 0 ? { cycleRefs } : {}),
      };
    }

    const roots = rootIds
      .map(r => make(r, 0, new Set()))
      .filter((t): t is TreeNode => t !== null);

    // Orphans: agents that appear in no delegation edge at all
    const orphans: TreeNode[] = nodes
      .filter(n => !inAnyEdge.has(n.id))
      .sort(
        (a, b) =>
          (tierOrder[a.model ?? ''] ?? 3) - (tierOrder[b.model ?? ''] ?? 3) ||
          a.label.localeCompare(b.label),
      )
      .map(n => ({ ...n, children: [], depth: 0 }));

    return { roots, orphans };
  }

  function countDescendants(node: TreeNode): number {
    let count = node.children.length;
    for (const c of node.children) count += countDescendants(c);
    return count;
  }

  function toggle(id: string) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id); else next.add(id);
    collapsed = next;
  }

  function isCollapsed(id: string): boolean {
    return collapsed.has(id);
  }

  // Auto-collapse deep branches on load
  function autoCollapse(nodes: TreeNode[], threshold: number) {
    const set = new Set<string>();
    function walk(n: TreeNode) {
      if (n.depth >= threshold && n.children.length > 0) set.add(n.id);
      n.children.forEach(walk);
    }
    nodes.forEach(walk);
    collapsed = set;
  }

  async function load() {
    loading = true; error = null;
    try {
      const res = await fetch('/api/v5/org-graph');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const apiData = json.data ?? json ?? { nodes: [], edges: [] };
      totalNodes = apiData.nodes?.length ?? 0;
      totalEdges = apiData.edges?.length ?? 0;
      const result = buildTree(apiData.nodes ?? [], apiData.edges ?? []);
      roots = result.roots;
      orphans = result.orphans;
      autoCollapse(roots, 3);
    } catch (e) { error = String(e); } finally { loading = false; }
  }

  onMount(() => {
    // $effect.pre already synced server data before this runs (loading=false).
    // Only fall back to the API fetch when no server data was available — i.e.
    // pure SPA deployment mode where +page.server.ts does not run.
    if (loading) load();
  });
</script>

<svelte:head><title>Org Chart — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Organization Chart</h1>
    <p class="page-subtitle">
      {totalNodes} agents · {totalEdges} delegation edges
      {#if orphans.length > 0}
        · <span class="orphan-hint">{orphans.length} unlinked</span>
      {/if}
    </p>
  </div>
  <div class="header-actions">
    <div class="legend">
      {#each Object.entries(MODEL_COLORS) as [tier, color]}
        <span class="legend-item"><span class="legend-dot" style="background:{color}"></span>{tier}</span>
      {/each}
    </div>
    <button class="btn-ghost" onclick={() => { collapsed = new Set(); orphansCollapsed = false; }}>Expand All</button>
    <button class="btn-ghost" onclick={() => { autoCollapse(roots, 2); orphansCollapsed = true; }}>Collapse</button>
  </div>
</div>

{#if loading}
  <div class="loading-state">Loading organization…</div>
{:else if error}
  <div class="error-state">Failed to load org graph. <button class="btn-ghost" onclick={load}>Retry</button></div>
{:else if roots.length === 0 && orphans.length === 0}
  <div class="empty-state">
    <p>No agents found. Add agent YAML files to <code>.agentforge/agents/</code> to populate the org chart.</p>
  </div>
{:else}
  <div class="tree-container">
    <!-- Delegation hierarchy -->
    {#if roots.length > 0}
      {#each roots as root (root.id)}
        {@render treeNode(root)}
      {/each}
    {/if}

    <!-- Unlinked agents (not in any delegation edge) -->
    {#if orphans.length > 0}
      <div class="section-divider">
        <button
          class="section-toggle"
          onclick={() => (orphansCollapsed = !orphansCollapsed)}
          aria-expanded={!orphansCollapsed}
        >
          <span class="section-expand">{orphansCollapsed ? '▸' : '▾'}</span>
          <span class="section-label">Unlinked Agents</span>
          <span class="section-count">{orphans.length}</span>
        </button>
      </div>

      {#if !orphansCollapsed}
        <div class="orphan-grid">
          {#each orphans as node (node.id)}
            {@const color = MODEL_COLORS[node.model ?? ''] ?? '#666'}
            <div class="orphan-card" style="border-left-color:{color};">
              <span class="node-name">{node.label ?? node.id}</span>
              <span class="model-pill" style="color:{color}; background:{color}18; border-color:{color}44;">
                {node.model ?? '—'}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
{/if}

{#snippet treeNode(node: TreeNode)}
  {@const color = MODEL_COLORS[node.model ?? ''] ?? '#666'}
  {@const bg = MODEL_BG[node.model ?? ''] ?? 'transparent'}
  {@const hasKids = node.children.length > 0}
  {@const isClosed = isCollapsed(node.id)}
  {@const desc = countDescendants(node)}

  <div class="tree-row depth-{Math.min(node.depth, 5)}">
    <button
      class="node-card"
      class:has-children={hasKids}
      class:is-root={node.depth === 0}
      class:is-exec={node.depth <= 1}
      style="border-left-color:{color}; background:{node.depth <= 1 ? bg : 'var(--color-surface-1)'};"
      onclick={() => hasKids && toggle(node.id)}
    >
      <span class="node-expand">{#if hasKids}{isClosed ? '▸' : '▾'}{:else}<span class="node-leaf">·</span>{/if}</span>
      <span class="node-name">{node.label ?? node.id}</span>
      <span class="model-pill" style="color:{color}; background:{color}18; border-color:{color}44;">{node.model ?? '—'}</span>
      {#if hasKids}
        <span class="child-count">{desc}</span>
      {/if}
      {#if node.cycleRefs && node.cycleRefs.length > 0}
        <span class="cycle-badge" title="Cycle detected: {node.cycleRefs.join(', ')}">↺</span>
      {/if}
    </button>

    {#if hasKids && !isClosed}
      <div class="children-block">
        {#each node.children as child (child.id)}
          {@render treeNode(child)}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<style>
  .page-header {
    display: flex; justify-content: space-between; align-items: flex-start;
    margin-bottom: var(--space-4); flex-wrap: wrap; gap: var(--space-3);
  }
  .page-title { font-size: var(--text-xl); font-weight: 600; color: var(--color-text); margin: 0 0 var(--space-1); }
  .page-subtitle { font-size: var(--text-sm); color: var(--color-text-muted); margin: 0; }
  .orphan-hint { color: var(--color-text-faint); }
  .header-actions { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .legend { display: flex; align-items: center; gap: var(--space-3); }
  .legend-item { display: flex; align-items: center; gap: 4px; font-size: var(--text-xs); color: var(--color-text-muted); font-weight: 500; text-transform: capitalize; }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .btn-ghost {
    background: transparent; border: 1px solid var(--color-border); color: var(--color-text-muted);
    padding: var(--space-1) var(--space-3); border-radius: var(--radius-md); font-size: var(--text-xs);
    cursor: pointer; transition: border-color 0.15s, color 0.15s;
  }
  .btn-ghost:hover { border-color: var(--color-border-strong); color: var(--color-text); }

  .loading-state, .error-state, .empty-state {
    padding: var(--space-8); text-align: center; font-size: var(--text-sm); color: var(--color-text-muted);
  }
  .empty-state code {
    font-family: var(--font-mono); font-size: var(--text-xs);
    background: var(--color-surface-2); padding: 2px 6px; border-radius: var(--radius-sm);
  }

  /* ── Tree layout ─────────────────────────────────────────── */
  .tree-container {
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    max-height: calc(100vh - 160px);
    overflow-y: auto;
  }

  .tree-row { margin-left: 0; }
  .tree-row.depth-1 { margin-left: 20px; }
  .tree-row.depth-2 { margin-left: 40px; }
  .tree-row.depth-3 { margin-left: 56px; }
  .tree-row.depth-4 { margin-left: 68px; }
  .tree-row.depth-5 { margin-left: 76px; }

  .children-block {
    border-left: 1px solid var(--color-border);
    margin-left: 12px;
    padding-left: 0;
  }

  .node-card {
    display: flex; align-items: center; gap: var(--space-2);
    width: 100%; padding: 6px var(--space-3);
    background: var(--color-surface-1);
    border: none; border-left: 3px solid;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    cursor: default; text-align: left;
    transition: background 0.12s;
    margin-bottom: 1px;
  }
  .node-card.has-children { cursor: pointer; }
  .node-card.has-children:hover { background: var(--color-bg-card-hover); }
  .node-card.is-root {
    padding: 10px var(--space-4); border-left-width: 4px;
    border-radius: var(--radius-md); margin-bottom: var(--space-1);
  }
  .node-card.is-exec {
    padding: 8px var(--space-3); border-left-width: 4px;
    margin-bottom: 1px;
  }

  .node-expand {
    width: 14px; flex-shrink: 0;
    font-size: 12px; color: var(--color-text-muted);
    text-align: center; line-height: 1;
  }
  .node-leaf { opacity: 0.3; }

  .node-name {
    font-size: var(--text-sm); font-weight: 500; color: var(--color-text);
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .is-root .node-name { font-size: 15px; font-weight: 700; }
  .is-exec .node-name { font-weight: 600; }

  .model-pill {
    font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
    padding: 1px 6px; border-radius: 999px; border: 1px solid;
    white-space: nowrap; flex-shrink: 0;
  }

  .child-count {
    font-size: 10px; color: var(--color-text-faint); font-family: var(--font-mono);
    background: var(--color-surface-2); padding: 0 5px; border-radius: 999px;
    flex-shrink: 0;
  }

  .cycle-badge {
    font-size: 10px; color: var(--color-text-faint);
    opacity: 0.5; flex-shrink: 0; cursor: help;
  }

  /* ── Section divider (for Unlinked Agents) ──────────────── */
  .section-divider {
    margin: var(--space-4) 0 var(--space-2);
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-3);
  }

  .section-toggle {
    display: flex; align-items: center; gap: var(--space-2);
    background: none; border: none; cursor: pointer;
    padding: 0; color: var(--color-text-muted);
    font-size: var(--text-xs); font-weight: 500;
    transition: color 0.12s;
  }
  .section-toggle:hover { color: var(--color-text); }

  .section-expand {
    font-size: 11px; width: 12px; text-align: center;
  }

  .section-label {
    text-transform: uppercase; letter-spacing: 0.08em; font-size: 10px;
  }

  .section-count {
    font-family: var(--font-mono); font-size: 10px;
    background: var(--color-surface-2); padding: 0 5px; border-radius: 999px;
    color: var(--color-text-faint);
  }

  /* ── Orphan grid ─────────────────────────────────────────── */
  .orphan-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 2px;
    margin-top: var(--space-2);
  }

  .orphan-card {
    display: flex; align-items: center; gap: var(--space-2);
    padding: 5px var(--space-3);
    background: var(--color-surface-1);
    border-left: 3px solid;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }

  .orphan-card .node-name {
    font-size: var(--text-xs); font-weight: 400;
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--color-text-muted);
  }
</style>
