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
 */
import type { PageServerLoad } from './$types';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

/**
 * Minimal YAML top-level field extractor.
 * Handles: key: value, key: 'value', key: "value", and block scalars (> and |).
 * Only extracts fields in wantKeys. Does not recurse into nested mappings.
 * Avoids adding js-yaml as a dashboard package dependency.
 */
function extractYamlFields(content: string, wantKeys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const wanted = new Set(wantKeys);
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)/);
    if (!m) { i++; continue; }
    const key = m[1];
    const rest = m[2].trim();
    if (!wanted.has(key)) { i++; continue; }
    if (rest === '>' || rest === '|') {
      const parts: string[] = [];
      i++;
      while (i < lines.length && /^[ \t]/.test(lines[i])) {
        parts.push(lines[i].trim());
        i++;
      }
      result[key] = rest === '>' ? parts.join(' ') : parts.join('\n');
    } else if (rest !== '') {
      result[key] = rest.replace(/^["']|["']$/g, '');
      i++;
    } else {
      i++;
    }
  }
  return result;
}

/**
 * Extract collaboration.reports_to (string) and collaboration.can_delegate_to
 * (string[]) from an agent YAML file.
 *
 * Handles block-sequence style:
 *   collaboration:
 *     reports_to: manager
 *     can_delegate_to:
 *       - worker1
 *       - worker2
 *
 * And inline list style:
 *   collaboration:
 *     can_delegate_to: [worker1, worker2]
 */
function extractCollaboration(content: string): {
  reportsTo: string | null;
  canDelegateTo: string[];
} {
  const lines = content.split('\n');
  let inCollab = false;
  let inDelegateList = false;
  let reportsTo: string | null = null;
  const canDelegateTo: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      // Top-level key — enter or exit collaboration block
      inCollab = trimmed.startsWith('collaboration:');
      inDelegateList = false;
      continue;
    }

    if (!inCollab) continue;

    // reports_to
    const rtMatch = trimmed.match(/^reports_to\s*:\s*(.*)/);
    if (rtMatch) {
      inDelegateList = false;
      const val = rtMatch[1].trim().replace(/^["']|["']$/g, '');
      if (val && val !== 'null' && val !== '~') reportsTo = val;
      continue;
    }

    // can_delegate_to
    const cdMatch = trimmed.match(/^can_delegate_to\s*:\s*(.*)/);
    if (cdMatch) {
      const rest = cdMatch[1].trim();
      inDelegateList = true;
      if (rest.startsWith('[')) {
        // Inline list: [a, b, c]
        const inner = rest.slice(1, rest.lastIndexOf(']'));
        canDelegateTo.push(
          ...inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean),
        );
        inDelegateList = false;
      }
      continue;
    }

    // Another collaboration sub-key ends the delegate list
    if (inDelegateList && !trimmed.startsWith('-') && /^[A-Za-z_]/.test(trimmed)) {
      inDelegateList = false;
    }

    // List item under can_delegate_to
    if (inDelegateList && trimmed.startsWith('- ')) {
      const val = trimmed.slice(2).trim().replace(/^["']|["']$/g, '');
      if (val) canDelegateTo.push(val);
    }
  }

  return { reportsTo, canDelegateTo };
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
export function buildOrgGraph(projectRoot: string): { nodes: OrgNodeData[]; edges: OrgEdgeData[] } {
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
        const fields = extractYamlFields(content, ['name', 'model']);
        nodes.push({ id, label: fields.name ?? id, model: fields.model });
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
    const { canDelegateTo } = extractCollaboration(content);
    for (const to of canDelegateTo) addEdge(id, to);
  }

  // Source 2: reports_to (child declares parent — fills gaps in can_delegate_to)
  for (const [id, content] of agentContents) {
    const { reportsTo } = extractCollaboration(content);
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

export const load: PageServerLoad = () => buildOrgGraph(findProjectRoot());
