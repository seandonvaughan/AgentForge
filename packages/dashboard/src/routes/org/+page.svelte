<script lang="ts">
  /**
   * /org — Organization Graph page (v2 design).
   *
   * Rebuilt to match design/v2-handoff/prototype/page-agents.jsx OrgGraphPage.
   * Two views: tree (hierarchical collapsible) + graph (radial SVG layout).
   *
   * Data: SSR via +page.server.ts (reads .agentforge/agents/*.yaml) + API fallback
   *       GET /api/v5/org-graph for SPA mode.
   */
  import { goto } from '$app/navigation';
  import { onMount, untrack } from 'svelte';
  import { Badge, Btn, Card, ModelChip } from '$lib/components/v2';
  import type { PageData } from './$types';
  import type { OrgNodeData, OrgEdgeData } from './+page.server';

  let { data }: { data: PageData } = $props();

  // ── Types ────────────────────────────────────────────────────────────────────
  interface OrgNode { id: string; label: string; model?: 'opus' | 'sonnet' | 'haiku'; }
  interface OrgEdge { from: string; to: string; }
  interface TreeNode extends OrgNode {
    children: TreeNode[];
    depth: number;
    cycleRefs?: string[];
  }

  // ── View toggle ──────────────────────────────────────────────────────────────
  let view: 'tree' | 'graph' = $state('tree');

  // ── Tree state ───────────────────────────────────────────────────────────────
  const _serverNodes: OrgNode[] = untrack(() => (data.nodes as OrgNodeData[] as OrgNode[]) ?? []);
  const _serverEdges: OrgEdge[] = untrack(() => (data.edges as OrgEdgeData[] as OrgEdge[]) ?? []);
  const _init = _serverNodes.length > 0
    ? buildTree(_serverNodes, _serverEdges)
    : { roots: [] as TreeNode[], orphans: [] as TreeNode[] };

  let roots: TreeNode[] = $state(_init.roots);
  let orphans: TreeNode[] = $state(_init.orphans);
  let loading = $state(_serverNodes.length === 0);
  let error: string | null = $state(null);
  let totalNodes = $state(_serverNodes.length);
  let totalEdges = $state(_serverEdges.length);
  let orphansCollapsed = $state(true);
  let collapsed: Set<string> = $state(computeAutoCollapsed(_init.roots));

  // Re-sync on data changes
  $effect(() => {
    const nodes: OrgNode[] = (data.nodes as OrgNodeData[] as OrgNode[]) ?? [];
    const edges: OrgEdge[] = (data.edges as OrgEdgeData[] as OrgEdge[]) ?? [];
    if (nodes.length === 0) return;
    const result = buildTree(nodes, edges);
    roots = result.roots;
    orphans = result.orphans;
    totalNodes = nodes.length;
    totalEdges = edges.length;
    collapsed = computeAutoCollapsed(result.roots);
    loading = false;
  });

  // ── Model color helpers ───────────────────────────────────────────────────────
  const MODEL_COLOR: Record<string, string> = {
    opus: 'var(--af-opus)', sonnet: 'var(--af-sonnet)', haiku: 'var(--af-haiku)',
  };
  const MODEL_BG: Record<string, string> = {
    opus: 'rgba(245,166,35,0.08)', sonnet: 'rgba(122,160,247,0.08)', haiku: 'rgba(91,211,148,0.08)',
  };
  const MODEL_HEX: Record<string, string> = {
    opus: '#f5a623', sonnet: '#7aa0f7', haiku: '#5bd394',
  };

  function colorFor(model: string | undefined): string {
    return MODEL_COLOR[model ?? ''] ?? 'var(--af-border3)';
  }
  function hexFor(model: string | undefined): string {
    return MODEL_HEX[model ?? ''] ?? '#52525b';
  }

  // ── Tree builder (preserved from v1, improved for v2 display) ────────────────
  function computeAutoCollapsed(treeRoots: TreeNode[]): Set<string> {
    const set = new Set<string>();
    (function walk(ns: TreeNode[]) {
      for (const n of ns) {
        if (n.depth >= 3 && n.children.length > 0) set.add(n.id);
        walk(n.children);
      }
    })(treeRoots);
    return set;
  }

  function buildTree(nodes: OrgNode[], edges: OrgEdge[]): { roots: TreeNode[]; orphans: TreeNode[] } {
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
    const rootIds = [...inAnyEdge].filter(id => !hasParent.has(id));
    const priority: Record<string, number> = { ceo: 0, genesis: 1 };
    rootIds.sort((a, b) => (priority[a] ?? 99) - (priority[b] ?? 99) || a.localeCompare(b));
    const tierOrder: Record<string, number> = { opus: 0, sonnet: 1, haiku: 2 };

    function make(id: string, depth: number, ancestorStack: Set<string>): TreeNode | null {
      const node = nodeMap.get(id);
      if (!node) return null;
      if (ancestorStack.has(id)) return null;
      const nextStack = new Set(ancestorStack);
      nextStack.add(id);
      const childIds = childrenOf.get(id) ?? [];
      const children: TreeNode[] = [];
      const cycleRefs: string[] = [];
      for (const cid of childIds) {
        if (nextStack.has(cid)) { cycleRefs.push(cid); }
        else {
          const child = make(cid, depth + 1, nextStack);
          if (child) children.push(child);
        }
      }
      children.sort(
        (a, b) => (tierOrder[a.model ?? ''] ?? 3) - (tierOrder[b.model ?? ''] ?? 3) || a.label.localeCompare(b.label)
      );
      return { ...node, children, depth, ...(cycleRefs.length > 0 ? { cycleRefs } : {}) };
    }

    const treeRoots = rootIds.map(r => make(r, 0, new Set())).filter((t): t is TreeNode => t !== null);
    const treeOrphans: TreeNode[] = nodes
      .filter(n => !inAnyEdge.has(n.id))
      .sort((a, b) => (tierOrder[a.model ?? ''] ?? 3) - (tierOrder[b.model ?? ''] ?? 3) || a.label.localeCompare(b.label))
      .map(n => ({ ...n, children: [], depth: 0 }));
    return { roots: treeRoots, orphans: treeOrphans };
  }

  function countDescendants(node: TreeNode): number {
    let count = node.children.length;
    for (const c of node.children) count += countDescendants(c);
    return count;
  }

  function toggle(id: string): void {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id); else next.add(id);
    collapsed = next;
  }

  function expandAll(): void {
    collapsed = new Set();
    orphansCollapsed = false;
  }

  function collapseAll(): void {
    collapsed = computeAutoCollapsed(roots);
    orphansCollapsed = true;
  }

  // ── API fallback ─────────────────────────────────────────────────────────────
  async function load(): Promise<void> {
    loading = true; error = null;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch('/api/v5/org-graph', { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const apiData = json.data ?? json ?? { nodes: [], edges: [] };
      totalNodes = apiData.nodes?.length ?? 0;
      totalEdges = apiData.edges?.length ?? 0;
      const result = buildTree(apiData.nodes ?? [], apiData.edges ?? []);
      roots = result.roots;
      orphans = result.orphans;
      collapsed = computeAutoCollapsed(roots);
    } catch (e) {
      error = e instanceof DOMException && e.name === 'AbortError'
        ? 'Request timed out (10s). Is the backend running?'
        : String(e);
    } finally {
      clearTimeout(timeoutId);
      loading = false;
    }
  }

  onMount(() => {
    if (loading) load();
  });

  // ── Org graph SVG layout ─────────────────────────────────────────────────────
  const SVG_W = 700;
  const SVG_H = 520;

  interface SvgPos { x: number; y: number }

  function computeGraphLayout(
    nodes: OrgNode[],
    edges: OrgEdge[],
  ): Map<string, SvgPos> {
    // Compute depths from roots (BFS)
    const childrenOf = new Map<string, string[]>();
    const hasParent = new Set<string>();
    const inEdge = new Set<string>();
    edges.forEach(e => {
      if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
      childrenOf.get(e.from)!.push(e.to);
      hasParent.add(e.to);
      inEdge.add(e.from);
      inEdge.add(e.to);
    });

    const depths = new Map<string, number>();
    function setDepth(id: string, d: number, visited = new Set<string>()): void {
      if (visited.has(id)) return;
      if (depths.has(id) && (depths.get(id) ?? 0) <= d) return;
      depths.set(id, d);
      visited.add(id);
      (childrenOf.get(id) ?? []).forEach(c => setDepth(c, d + 1, new Set(visited)));
    }
    nodes.filter(n => !hasParent.has(n.id)).forEach(r => setDepth(r.id, 0));
    nodes.forEach(n => { if (!depths.has(n.id)) depths.set(n.id, 0); });

    // Group by depth
    const byDepth = new Map<number, OrgNode[]>();
    nodes.forEach(n => {
      const d = depths.get(n.id) ?? 0;
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)!.push(n);
    });

    const pos = new Map<string, SvgPos>();
    const cx = SVG_W / 2;
    const cy = SVG_H / 2;

    byDepth.forEach((nds, depth) => {
      if (depth === 0) {
        nds.forEach(n => pos.set(n.id, { x: cx, y: cy - 200 }));
      } else {
        const r = depth * 105;
        nds.forEach((n, i) => {
          const angle = (i / nds.length) * Math.PI * 2 - Math.PI / 2 + depth * 0.12;
          pos.set(n.id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) * 0.72 });
        });
      }
    });

    return pos;
  }

  let svgPositions = $derived.by(() => {
    const allNodes: OrgNode[] = [...roots, ...orphans].flatMap(function flatten(n: TreeNode): OrgNode[] {
      return [n, ...n.children.flatMap(flatten)];
    });
    const seen = new Set<string>();
    const deduped = allNodes.filter(n => { if (seen.has(n.id)) return false; seen.add(n.id); return true; });

    const allEdges: OrgEdge[] = [];
    const edgeSeen = new Set<string>();
    function collectEdges(node: TreeNode): void {
      for (const child of node.children) {
        const key = `${node.id}\0${child.id}`;
        if (!edgeSeen.has(key)) { edgeSeen.add(key); allEdges.push({ from: node.id, to: child.id }); }
        collectEdges(child);
      }
    }
    roots.forEach(collectEdges);

    return computeGraphLayout(deduped, allEdges);
  });

  // Flat node list for SVG rendering
  let svgNodes = $derived.by<OrgNode[]>(() => {
    const seen = new Set<string>();
    const result: OrgNode[] = [];
    function collect(n: TreeNode): void {
      if (!seen.has(n.id)) { seen.add(n.id); result.push(n); }
      n.children.forEach(collect);
    }
    roots.forEach(collect);
    orphans.forEach(n => { if (!seen.has(n.id)) { seen.add(n.id); result.push(n); } });
    return result;
  });

  let svgEdges = $derived.by<OrgEdge[]>(() => {
    const seen = new Set<string>();
    const result: OrgEdge[] = [];
    function collect(n: TreeNode): void {
      for (const child of n.children) {
        const key = `${n.id}\0${child.id}`;
        if (!seen.has(key)) { seen.add(key); result.push({ from: n.id, to: child.id }); }
        collect(child);
      }
    }
    roots.forEach(collect);
    return result;
  });

  // Cost grouping for sidebar (approximate — no real cost data without sessions)
  let modelMix = $derived({
    opus:   (data.nodes as OrgNodeData[]).filter(n => n.model === 'opus').length,
    sonnet: (data.nodes as OrgNodeData[]).filter(n => n.model === 'sonnet').length,
    haiku:  (data.nodes as OrgNodeData[]).filter(n => n.model === 'haiku').length,
  });
  let modelTotal = $derived(modelMix.opus + modelMix.sonnet + modelMix.haiku);
</script>

<svelte:head><title>Org Graph — AgentForge</title></svelte:head>

<!-- ── Page header ──────────────────────────────────────────────────────────── -->
<header class="af-page-header">
  <div class="af-crumbs font-mono">Workspace · Org Graph</div>
  <div class="af-headline-row">
    <div>
      <h1 class="af-title">Organization graph</h1>
      <p class="af-subtitle">
        <span class="font-mono">{totalNodes}</span> agents ·
        <span class="font-mono">{totalEdges}</span> delegation edges
        {#if orphans.length > 0}
          · <span class="af-orphan-hint">{orphans.length} unlinked</span>
        {/if}
      </p>
    </div>
    <div class="af-actions">
      <!-- Tree / Graph toggle -->
      <div class="af-view-toggle">
        <button
          class="af-view-btn {view === 'tree' ? 'active' : ''}"
          onclick={() => (view = 'tree')}
        >Tree</button>
        <button
          class="af-view-btn {view === 'graph' ? 'active' : ''}"
          onclick={() => (view = 'graph')}
        >Graph</button>
      </div>
      <Btn size="sm" onclick={expandAll}>Expand all</Btn>
      <Btn size="sm" onclick={collapseAll}>Collapse</Btn>
    </div>
  </div>
</header>

<!-- ── States ────────────────────────────────────────────────────────────────── -->
{#if loading}
  <div class="af-loading">Loading organization…</div>
{:else if error}
  <div class="af-error" data-testid="org-error">
    {error}
    <Btn size="sm" onclick={load}>Retry</Btn>
  </div>
{:else if roots.length === 0 && orphans.length === 0}
  <div class="af-empty">
    No agents found. Add agent YAML files to <code class="af-code">.agentforge/agents/</code> to populate the org chart.
  </div>
{:else}
  <div class="af-org-layout">
    <!-- ── Left: tree or graph ───────────────────────────────────────────────── -->
    <Card noPad style="min-height:580px;">
      <div class="af-tree-head">
        <span class="af-section-title">{view === 'tree' ? 'HIERARCHY' : 'GRAPH'}</span>
        {#if view === 'tree'}
          <div class="af-legend">
            <span><span class="af-leg-dot" style="background:var(--af-opus)"></span><span class="af-leg-label">opus</span></span>
            <span><span class="af-leg-dot" style="background:var(--af-sonnet)"></span><span class="af-leg-label">sonnet</span></span>
            <span><span class="af-leg-dot" style="background:var(--af-haiku)"></span><span class="af-leg-label">haiku</span></span>
          </div>
        {/if}
      </div>

      {#if view === 'tree'}
        <!-- Tree view -->
        <div class="af-tree-body" data-testid="org-tree">
          {#if roots.length > 0}
            <div data-testid="org-hierarchy">
              {#each roots as root (root.id)}
                {@render treeNode(root)}
              {/each}
            </div>
          {/if}

          {#if orphans.length > 0}
            <div class="af-orphan-divider">
              <button
                class="af-section-toggle"
                onclick={() => (orphansCollapsed = !orphansCollapsed)}
                aria-expanded={!orphansCollapsed}
              >
                <span class="af-expand-icon">{orphansCollapsed ? '▸' : '▾'}</span>
                <span class="af-section-label">Unlinked Agents</span>
                <span class="af-section-count font-mono">{orphans.length}</span>
              </button>
            </div>
            {#if !orphansCollapsed}
              <div class="af-orphan-grid">
                {#each orphans as node (node.id)}
                  {@const color = colorFor(node.model)}
                  <button
                    class="af-orphan-card"
                    style="border-left-color:{color}"
                    onclick={() => goto(`/agents/${node.id}`)}
                    data-testid="org-node"
                    data-agent-id={node.id}
                  >
                    <span class="af-node-name">{node.label ?? node.id}</span>
                    <span class="af-model-pill" style="color:{color}; background:{color}18; border-color:{color}44;">{node.model ?? '—'}</span>
                  </button>
                {/each}
              </div>
            {/if}
          {/if}
        </div>

      {:else}
        <!-- Graph (radial SVG) view -->
        <div class="af-graph-wrap">
          <svg width="100%" viewBox="0 0 {SVG_W} {SVG_H}" class="af-graph-svg">
            <defs>
              <linearGradient id="org-edge-grad" x1="0" x2="1">
                <stop offset="0%" stop-color="var(--af-accent)" stop-opacity="0.5" />
                <stop offset="100%" stop-color="var(--af-purple)" stop-opacity="0.5" />
              </linearGradient>
            </defs>
            <!-- Edges -->
            {#each svgEdges as e (`${e.from}→${e.to}`)}
              {@const p = svgPositions.get(e.from)}
              {@const c = svgPositions.get(e.to)}
              {#if p && c}
                <line x1={p.x} y1={p.y} x2={c.x} y2={c.y}
                  stroke="url(#org-edge-grad)" stroke-width="1" opacity="0.4" />
              {/if}
            {/each}
            <!-- Nodes -->
            {#each svgNodes as n (n.id)}
              {@const pos = svgPositions.get(n.id)}
              {#if pos}
                {@const hex = hexFor(n.model)}
                {@const r = 7}
                <g
                  role="button"
                  tabindex="0"
                  onclick={() => goto(`/agents/${n.id}`)}
                  onkeydown={e => e.key === 'Enter' && goto(`/agents/${n.id}`)}
                  style="cursor:pointer"
                >
                  <circle cx={pos.x} cy={pos.y} r={r + 3} fill={hex} opacity="0.12" />
                  <circle cx={pos.x} cy={pos.y} r={r} fill="var(--af-surface)" stroke={hex} stroke-width="1.5" />
                  <circle cx={pos.x} cy={pos.y} r={r - 3} fill={hex} opacity="0.7" />
                  <text
                    x={pos.x} y={pos.y + r + 11}
                    fill="var(--af-muted)" font-size="9"
                    text-anchor="middle"
                    font-family="Inter, system-ui, sans-serif"
                  >{n.label ?? n.id}</text>
                </g>
              {/if}
            {/each}
          </svg>
        </div>
      {/if}
    </Card>

    <!-- ── Right: stats ───────────────────────────────────────────────────────── -->
    <div class="af-right-col">
      <!-- Model mix -->
      <Card>
        <div class="af-section-header">
          <span class="af-section-title">BY MODEL</span>
        </div>
        <div class="af-model-mix">
          {#each ([
            { model: 'opus',   color: 'var(--af-opus)',   count: modelMix.opus },
            { model: 'sonnet', color: 'var(--af-sonnet)', count: modelMix.sonnet },
            { model: 'haiku',  color: 'var(--af-haiku)',  count: modelMix.haiku },
          ]) as m}
            {@const pct = modelTotal > 0 ? (m.count / modelTotal) * 100 : 0}
            <div class="af-model-row">
              <div class="af-model-label-row">
                <span class="af-model-dot" style="background:{m.color}"></span>
                <span class="font-mono af-model-name">{m.model}</span>
                <span class="font-mono af-model-count">{m.count} <span class="af-model-pct">({pct.toFixed(0)}%)</span></span>
              </div>
              <div class="af-model-bar">
                <div class="af-model-fill" style="width:{pct}%; background:{m.color};"></div>
              </div>
            </div>
          {/each}
        </div>
      </Card>

      <!-- All agents list (top-down, sorted by model tier) -->
      <Card noPad>
        <div class="af-tree-head">
          <span class="af-section-title">ALL AGENTS</span>
          <span class="font-mono af-section-count">{totalNodes}</span>
        </div>
        <div class="af-agent-scroll">
          {#each (data.nodes as OrgNodeData[]).sort((a, b) => {
            const t: Record<string, number> = { opus: 0, sonnet: 1, haiku: 2 };
            return (t[a.model ?? ''] ?? 3) - (t[b.model ?? ''] ?? 3) || a.label.localeCompare(b.label);
          }) as node}
            {@const color = colorFor(node.model)}
            <button
              class="af-agent-row-btn"
              onclick={() => goto(`/agents/${node.id}`)}
            >
              <span class="af-agent-color-bar" style="background:{color}"></span>
              <span class="af-agent-row-name">{node.label ?? node.id}</span>
              <ModelChip model={node.model as 'opus' | 'sonnet' | 'haiku'} />
            </button>
          {/each}
        </div>
      </Card>
    </div>
  </div>
{/if}

<!-- ── Tree node snippet ───────────────────────────────────────────────────── -->
{#snippet treeNode(node: TreeNode)}
  {@const color = colorFor(node.model)}
  {@const bg = MODEL_BG[node.model ?? ''] ?? 'transparent'}
  {@const hasKids = node.children.length > 0}
  {@const isClosed = collapsed.has(node.id)}
  {@const desc = countDescendants(node)}

  <div class="af-tree-row depth-{Math.min(node.depth, 5)}">
    <div
      class="af-node-card {hasKids ? 'clickable' : ''} {node.depth === 0 ? 'is-root' : ''} {node.depth <= 1 ? 'is-exec' : ''}"
      role={hasKids ? 'button' : undefined}
      tabindex={hasKids ? 0 : undefined}
      style="border-left-color:{color}; background:{node.depth <= 1 ? bg : 'var(--af-surface)'};"
      onclick={() => {
        if (hasKids) toggle(node.id);
        else goto(`/agents/${node.id}`);
      }}
      onkeydown={e => {
        if (e.key === 'Enter') {
          if (hasKids) toggle(node.id);
          else goto(`/agents/${node.id}`);
        }
      }}
      data-testid="org-node"
      data-agent-id={node.id}
    >
      <span class="af-expand-icon">{hasKids ? (isClosed ? '▸' : '▾') : ''}</span>
      <span class="af-node-name">{node.label ?? node.id}</span>
      <ModelChip model={node.model} />
      {#if hasKids}
        <span class="font-mono af-child-count">{desc}</span>
      {/if}
      {#if !hasKids}
        <button
          class="af-go-btn"
          onclick={(e) => { e.stopPropagation(); goto(`/agents/${node.id}`); }}
          tabindex={-1}
          aria-label="Open {node.label ?? node.id} detail"
        >→</button>
      {/if}
      {#if node.cycleRefs && node.cycleRefs.length > 0}
        <span class="af-cycle-badge" title="Cycle: {node.cycleRefs.join(', ')}">↺</span>
      {/if}
    </div>

    {#if hasKids && !isClosed}
      <div class="af-children-block">
        {#each node.children as child (child.id)}
          {@render treeNode(child)}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<style>
  /* ── Page header ─────────────────────────────────────────────────────── */
  .af-page-header {
    display: flex; flex-direction: column;
    gap: 6px; margin-bottom: 14px;
  }
  .af-crumbs {
    font-size: 11px; color: var(--af-dim);
    letter-spacing: 0.04em; text-transform: uppercase;
  }
  .af-headline-row {
    display: flex; align-items: flex-start;
    justify-content: space-between; gap: 12px; flex-wrap: wrap;
  }
  .af-title {
    margin: 0 0 2px; font-size: 22px; font-weight: 600;
    letter-spacing: -0.01em; color: var(--af-text);
  }
  .af-subtitle { margin: 0; font-size: 12px; color: var(--af-muted); }
  .af-orphan-hint { color: var(--af-faint); }
  .af-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

  /* ── View toggle ─────────────────────────────────────────────────────── */
  .af-view-toggle {
    display: flex; gap: 0;
    background: var(--af-surface); border: 1px solid var(--af-border2);
    border-radius: 6px; padding: 2px;
  }
  .af-view-btn {
    padding: 4px 12px; border-radius: 4px; font-size: 11px;
    font-weight: 500; cursor: pointer; background: transparent;
    border: none; color: var(--af-dim); transition: background 120ms, color 120ms;
  }
  .af-view-btn:hover { color: var(--af-text); }
  .af-view-btn.active { background: var(--af-surface2); color: var(--af-text); }

  /* ── Layout ──────────────────────────────────────────────────────────── */
  .af-org-layout {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 14px;
  }
  @media (max-width: 900px) {
    .af-org-layout { grid-template-columns: 1fr; }
  }
  .af-right-col { display: flex; flex-direction: column; gap: 12px; }

  /* ── Tree head ───────────────────────────────────────────────────────── */
  .af-tree-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px; border-bottom: 1px solid var(--af-border);
  }
  .af-section-title {
    font-size: 10px; font-weight: 600; letter-spacing: 0.08em;
    color: var(--af-dim); text-transform: uppercase;
  }
  .af-legend { display: flex; gap: 12px; font-size: 10px; }
  .af-leg-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 4px; }
  .af-leg-label { color: var(--af-dim); }

  /* ── Tree body ───────────────────────────────────────────────────────── */
  .af-tree-body {
    padding: 10px 10px 10px 4px;
    max-height: calc(100vh - 220px);
    overflow-y: auto;
  }
  .af-tree-row { margin-left: 0; }
  .af-tree-row.depth-1 { margin-left: 20px; }
  .af-tree-row.depth-2 { margin-left: 40px; }
  .af-tree-row.depth-3 { margin-left: 56px; }
  .af-tree-row.depth-4 { margin-left: 68px; }
  .af-tree-row.depth-5 { margin-left: 76px; }

  .af-children-block {
    border-left: 1px solid var(--af-border);
    margin-left: 12px;
  }

  /* ── Node card ───────────────────────────────────────────────────────── */
  .af-node-card {
    display: grid;
    grid-template-columns: auto 1fr auto auto auto auto;
    align-items: center; gap: 8px;
    padding: 5px 12px;
    background: var(--af-surface); border: none;
    border-left: 3px solid;
    border-radius: 0 4px 4px 0;
    margin-bottom: 2px;
    transition: background 120ms;
    cursor: default;
    text-align: left; width: 100%;
  }
  .af-node-card.clickable { cursor: pointer; }
  .af-node-card.clickable:hover { background: var(--af-surface2); }
  .af-node-card.is-root {
    padding: 9px 12px; border-left-width: 4px;
    border-radius: 4px; margin-bottom: 3px;
  }
  .af-node-card.is-exec {
    padding: 7px 12px; border-left-width: 4px;
  }

  .af-expand-icon {
    width: 12px; flex-shrink: 0;
    font-size: 10px; color: var(--af-dim); text-align: center;
  }
  .af-node-name {
    font-size: 12px; font-weight: 500; color: var(--af-text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .is-root .af-node-name { font-size: 13px; font-weight: 700; }
  .is-exec .af-node-name { font-weight: 600; }

  .af-child-count {
    font-size: 10px; color: var(--af-faint);
    background: var(--af-surface2); padding: 0 5px;
    border-radius: 999px; flex-shrink: 0;
  }
  .af-go-btn {
    background: none; border: none; padding: 0 2px;
    color: var(--af-faint); font-size: 11px; cursor: pointer;
    opacity: 0; transition: opacity 120ms;
    flex-shrink: 0;
  }
  .af-node-card:hover .af-go-btn { opacity: 1; }
  .af-cycle-badge { font-size: 10px; color: var(--af-faint); opacity: 0.5; cursor: help; }

  /* ── Section header (used in card too) ──────────────────────────────── */
  .af-section-header {
    display: flex; align-items: center;
    justify-content: space-between; margin-bottom: 10px;
  }
  .af-section-count { font-size: 10px; color: var(--af-dim); }

  /* ── Orphan section ──────────────────────────────────────────────────── */
  .af-orphan-divider {
    margin: 14px 0 8px;
    border-top: 1px solid var(--af-border);
    padding-top: 10px;
  }
  .af-section-toggle {
    display: flex; align-items: center; gap: 6px;
    background: none; border: none; cursor: pointer;
    padding: 0; color: var(--af-dim); font-size: 11px;
    transition: color 120ms;
  }
  .af-section-toggle:hover { color: var(--af-text); }
  .af-section-label {
    text-transform: uppercase; letter-spacing: 0.08em; font-size: 10px; font-weight: 600;
  }
  .af-orphan-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 2px; margin-top: 6px;
  }
  .af-orphan-card {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 10px; background: var(--af-surface);
    border-left: 3px solid; border-radius: 0 4px 4px 0;
    cursor: pointer; text-align: left;
    transition: background 120ms;
  }
  .af-orphan-card:hover { background: var(--af-surface2); }
  .af-model-pill {
    font-size: 9px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em; padding: 1px 6px; border-radius: 999px;
    border: 1px solid; white-space: nowrap; flex-shrink: 0;
  }

  /* ── Graph SVG ───────────────────────────────────────────────────────── */
  .af-graph-wrap { padding: 14px; }
  .af-graph-svg { display: block; width: 100%; }

  /* ── Model mix ───────────────────────────────────────────────────────── */
  .af-model-mix { display: flex; flex-direction: column; gap: 10px; }
  .af-model-row { display: flex; flex-direction: column; gap: 4px; }
  .af-model-label-row {
    display: flex; align-items: center; gap: 6px; font-size: 12px;
  }
  .af-model-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .af-model-name { color: var(--af-text); text-transform: uppercase; font-size: 11px; flex: 1; }
  .af-model-count { font-size: 11px; color: var(--af-text); }
  .af-model-pct { color: var(--af-dim); }
  .af-model-bar {
    height: 4px; background: var(--af-border); border-radius: 2px; overflow: hidden;
  }
  .af-model-fill { height: 100%; transition: width 500ms ease; border-radius: 2px; }

  /* ── Agent scroll list ───────────────────────────────────────────────── */
  .af-agent-scroll { max-height: 320px; overflow-y: auto; }
  .af-agent-row-btn {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 14px; width: 100%; text-align: left;
    background: none; border: none; border-bottom: 1px solid var(--af-border);
    cursor: pointer; transition: background 120ms; color: inherit;
  }
  .af-agent-row-btn:hover { background: var(--af-surface2); }
  .af-agent-row-btn:last-child { border-bottom: none; }
  .af-agent-color-bar { width: 3px; height: 14px; border-radius: 2px; flex-shrink: 0; }
  .af-agent-row-name {
    font-size: 12px; color: var(--af-text); flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* ── States ──────────────────────────────────────────────────────────── */
  .af-loading, .af-error, .af-empty {
    padding: 40px; text-align: center; font-size: 13px; color: var(--af-dim);
  }
  .af-error { color: var(--af-danger); display: flex; align-items: center; justify-content: center; gap: 10px; }
  .af-code {
    font-family: var(--af-font-mono); font-size: 11px;
    background: var(--af-surface2); padding: 2px 6px; border-radius: 4px;
  }

  @media (prefers-reduced-motion: reduce) {
    .af-model-fill { transition: none; }
  }
</style>
