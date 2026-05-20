/**
 * Server-side load for /org.
 *
 * Reads .agentforge/agents/*.yaml and .agentforge/config/delegation.yaml
 * directly from the filesystem so the page renders with real delegation data
 * on the first request — no dependency on the Fastify backend server at
 * port 4750. This mirrors the pattern used by agents/+page.server.ts.
 *
 * Edge sources (in priority order, deduplicated):
 *   1. collaboration.can_delegate_to — parent's explicit outgoing delegation grants
 *   2. collaboration.reports_to     — child's declared parent (fills gaps)
 *   3. delegation.yaml              — supplementary legacy config
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  SSR load return shape (consumed as `data` prop in +page.svelte)    │
 * │                                                                      │
 * │  {                                                                   │
 * │    nodes: Array<{ id: string; label: string; model?: string }>      │
 * │    edges: Array<{ from: string; to: string }>                        │
 * │  }                                                                   │
 * │                                                                      │
 * │  ⚠ This is a FLAT shape — no `data` wrapper, no `meta` object.     │
 * │  The HTTP API at /api/v5/org-graph wraps this in:                   │
 * │    { data: { nodes, edges }, meta: { total, edgeCount, timestamp } } │
 * │  See packages/server/src/routes/v5/org-graph.ts for the full        │
 * │  API contract. The page's fetch() fallback unwraps via json.data.   │
 * └──────────────────────────────────────────────────────────────────────┘
 */
import type { PageServerLoad } from './$types';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export interface OrgNodeData {
  id: string;
  label: string;
  model?: string;
}

export interface OrgEdgeData {
  from: string;
  to: string;
}

/** Agents that are internal tooling — excluded from the operator-facing hierarchy. */
const EXCLUDED_AGENTS = new Set(['genesis', 'genesis-pipeline-dev']);

/** Walk up from CWD until .agentforge/agents/ is found. Matches agents/+page.server.ts. */
function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, '.agentforge', 'agents'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Parse delegation.yaml: maps manager-id → [report-id, ...].
 *
 * Expected format:
 *   manager:
 *     - report1
 *     - report2
 */
function parseDelegationYaml(content: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  let current: string | null = null;

  for (const line of content.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*:/);
      current = m ? m[1] : null;
      if (current) result[current] = [];
      continue;
    }

    if (current && trimmed.startsWith('- ')) {
      const val = trimmed.slice(2).trim().replace(/^["']|["']$/g, '');
      if (val) result[current].push(val);
    }
  }

  return result;
}

/**
 * Build the org graph (nodes + edges) from agent YAMLs and delegation.yaml.
 *
 * Extracted from `load` so tests can pass an explicit `projectRoot` without
 * having to change `process.cwd()`. The `load` function below calls this with
 * the auto-detected root.
 */
export function _buildOrgGraph(projectRoot: string): { nodes: OrgNodeData[]; edges: OrgEdgeData[] } {
  const agentsDir = join(projectRoot, '.agentforge', 'agents');
  const delegationPath = join(projectRoot, '.agentforge', 'config', 'delegation.yaml');

  const nodes: OrgNodeData[] = [];
  // Cache raw YAML per agent for the two collaboration parsing passes below
  const agentContents = new Map<string, string>();

  // ── Build nodes from agent YAMLs ───────────────────────────────────────────
  if (existsSync(agentsDir)) {
    let files: string[] = [];
    try {
      files = readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
    } catch { /* ignore read errors */ }

    for (const file of files) {
      const id = file.replace(/\.ya?ml$/, '');
      if (EXCLUDED_AGENTS.has(id)) continue;
      try {
        const content = readFileSync(join(agentsDir, file), 'utf-8');
        const fields = asRecord(yaml.load(content));
        nodes.push({
          id,
          label: typeof fields.name === 'string' ? fields.name : id,
          model: typeof fields.model === 'string' ? fields.model : undefined,
        });
        agentContents.set(id, content);
      } catch { /* skip malformed */ }
    }
  }

  // ── Build edges from three sources with deduplication ─────────────────────
  const edgeSet = new Set<string>();
  const edges: OrgEdgeData[] = [];

  function addEdge(from: string, to: string): void {
    if (EXCLUDED_AGENTS.has(from) || EXCLUDED_AGENTS.has(to)) return;
    const key = `${from}\0${to}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ from, to });
  }

  // Source 1: can_delegate_to (authoritative parent → child grants)
  for (const [id, content] of agentContents) {
    const doc = asRecord(yaml.load(content));
    const collab = asRecord(doc.collaboration);
    for (const to of asStringArray(collab.can_delegate_to)) addEdge(id, to);
  }

  // Source 2: reports_to (child declares parent — fills gaps in can_delegate_to)
  for (const [id, content] of agentContents) {
    const doc = asRecord(yaml.load(content));
    const collab = asRecord(doc.collaboration);
    const reportsTo = typeof collab.reports_to === 'string' ? collab.reports_to : null;
    if (reportsTo) addEdge(reportsTo, id);
  }

  // Source 3: delegation.yaml (supplementary legacy config)
  if (existsSync(delegationPath)) {
    try {
      const content = readFileSync(delegationPath, 'utf-8');
      const delegation = parseDelegationYaml(content);
      for (const [from, targets] of Object.entries(delegation)) {
        for (const to of targets) addEdge(from, to);
      }
    } catch { /* skip malformed */ }
  }

  return { nodes, edges };
}

export const load: PageServerLoad = () => _buildOrgGraph(findProjectRoot());
