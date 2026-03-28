<script lang="ts">
  import { onMount } from 'svelte';

  interface OrgNode { id: string; label: string; model?: 'opus' | 'sonnet' | 'haiku'; }
  interface OrgEdge { from: string; to: string; }

  interface TreeNode extends OrgNode {
    children: TreeNode[];
    depth: number;
  }

  let roots: TreeNode[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);
  let totalNodes = $state(0);
  let totalEdges = $state(0);
  let collapsed: Set<string> = $state(new Set());

  const MODEL_COLORS: Record<string, string> = {
    opus: '#f5c842', sonnet: '#4a9eff', haiku: '#4caf82',
  };
  const MODEL_BG: Record<string, string> = {
    opus: 'rgba(245,200,66,0.08)', sonnet: 'rgba(74,158,255,0.08)', haiku: 'rgba(76,175,130,0.08)',
  };

  function buildTree(nodes: OrgNode[], edges: OrgEdge[]): TreeNode[] {
    const nodeMap = new Map<string, OrgNode>();
    nodes.forEach(n => nodeMap.set(n.id, n));
    const childrenOf = new Map<string, string[]>();
    const hasParent = new Set<string>();
    edges.forEach(e => {
      if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
      childrenOf.get(e.from)!.push(e.to);
      hasParent.add(e.to);
    });
    const connected = new Set<string>();
    edges.forEach(e => { connected.add(e.from); connected.add(e.to); });
    const rootIds = [...connected].filter(id => !hasParent.has(id));
    const priority: Record<string, number> = { ceo: 0, genesis: 1 };
    rootIds.sort((a, b) => (priority[a] ?? 99) - (priority[b] ?? 99) || a.localeCompare(b));

    function make(id: string, depth: number, visited: Set<string>): TreeNode | null {
      if (visited.has(id)) return null;
      visited.add(id);
      const node = nodeMap.get(id);
      if (!node) return null;
      const kids = (childrenOf.get(id) ?? [])
        .map(cid => make(cid, depth + 1, visited))
        .filter((t): t is TreeNode => t !== null);
      const tierOrder: Record<string, number> = { opus: 0, sonnet: 1, haiku: 2 };
      kids.sort((a, b) => (tierOrder[a.model ?? ''] ?? 3) - (tierOrder[b.model ?? ''] ?? 3) || a.label.localeCompare(b.label));
      return { ...node, children: kids, depth };
    }
    const visited = new Set<string>();
    return rootIds.map(r => make(r, 0, visited)).filter((t): t is TreeNode => t !== null);
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
      const data = json.data ?? json ?? { nodes: [], edges: [] };
      totalNodes = data.nodes?.length ?? 0;
      totalEdges = data.edges?.length ?? 0;
      roots = buildTree(data.nodes ?? [], data.edges ?? []);
      autoCollapse(roots, 3);
    } catch (e) { error = String(e); } finally { loading = false; }
  }

  onMount(load);
</script>

<svelte:head><title>Org Chart — AgentForge v6</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Organization Chart</h1>
    <p class="page-subtitle">{totalNodes} agents · {totalEdges} delegation edges</p>
  </div>
  <div class="header-actions">
    <div class="legend">
      {#each Object.entries(MODEL_COLORS) as [tier, color]}
        <span class="legend-item"><span class="legend-dot" style="background:{color}"></span>{tier}</span>
      {/each}
    </div>
    <button class="btn-ghost" on:click={() => { collapsed = new Set(); }}>Expand All</button>
    <button class="btn-ghost" on:click={() => autoCollapse(roots, 2)}>Collapse</button>
  </div>
</div>

{#if loading}
  <div class="loading-state">Loading organization…</div>
{:else if error}
  <div class="error-state">Failed to load org graph. <button class="btn-ghost" on:click={load}>Retry</button></div>
{:else}
  <div class="tree-container">
    {#each roots as root (root.id)}
      {@render treeNode(root)}
    {/each}
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
      on:click={() => hasKids && toggle(node.id)}
    >
      <span class="node-expand">{#if hasKids}{isClosed ? '▸' : '▾'}{:else}<span class="node-leaf">·</span>{/if}</span>
      <span class="node-name">{node.label ?? node.id}</span>
      <span class="model-pill" style="color:{color}; background:{color}18; border-color:{color}44;">{node.model ?? '—'}</span>
      {#if hasKids}
        <span class="child-count">{desc}</span>
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

  .loading-state, .error-state {
    padding: var(--space-8); text-align: center; font-size: var(--text-sm); color: var(--color-text-muted);
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
</style>
