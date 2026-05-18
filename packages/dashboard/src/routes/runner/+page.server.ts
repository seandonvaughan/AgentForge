/**
 * Server-side load for /runner.
 *
 * Reads .agentforge/agents/*.yaml directly from the filesystem so the agent
 * selector renders with real data on the first request — no dependency on the
 * external backend server at port 4750 for the initial render.
 *
 * Uses the same minimal YAML field extractor as agents/+page.server.ts to
 * avoid a js-yaml dependency in this package's server bundle.
 *
 * Exports _loadRunnerAgents(root) for hermetic unit tests (same convention as
 * agents/+page.server.ts#_loadAgents and flywheel/+page.server.ts#_computeMetrics).
 */
import type { PageServerLoad } from './$types';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface RunnerAgentEntry {
  agentId: string;
  name: string;
  model: 'opus' | 'sonnet' | 'haiku';
}

/**
 * Minimal YAML top-level field extractor.
 *
 * Handles:
 *   key: simple value
 *   key: >          (folded block scalar — joins indented lines with spaces)
 *   key: |          (literal block scalar — preserves newlines)
 *
 * Only extracts the fields listed in `wantKeys`. Nested mappings are skipped.
 * This avoids a js-yaml dependency in the dashboard package's server bundle.
 */
function extractYamlFields(
  content: string,
  wantKeys: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');
  const wanted = new Set(wantKeys);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)/);
    if (!m) { i++; continue; }

    const key = m[1];
    const rest = m[2].trim();

    if (!wanted.has(key)) { i++; continue; }

    if (rest === '>' || rest === '|') {
      const scalar = rest;
      const parts: string[] = [];
      i++;
      while (i < lines.length && /^[ \t]/.test(lines[i])) {
        parts.push(lines[i].trim());
        i++;
      }
      result[key] = scalar === '>'
        ? parts.join(' ')
        : parts.join('\n');
    } else if (rest !== '') {
      result[key] = rest.replace(/^["']|["']$/g, '');
      i++;
    } else {
      i++;
    }
  }

  return result;
}

/** Walk up from CWD until we find a directory containing .agentforge/agents/. */
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
 * Core data-loading logic — reads every *.yaml file under
 * `<root>/.agentforge/agents/`, extracts name and model, and returns a
 * tier-sorted array of RunnerAgentEntry.
 *
 * Tier sort order: opus (0) → sonnet (1) → haiku (2), then alphabetical by
 * agentId within each tier — same ordering the client-side `filteredAgents`
 * derived uses so first-render and post-refresh orderings match.
 *
 * Malformed or unreadable files are silently skipped.
 */
export function _loadRunnerAgents(root: string): RunnerAgentEntry[] {
  const agentsDir = join(root, '.agentforge', 'agents');
  if (!existsSync(agentsDir)) return [];

  let files: string[] = [];
  try {
    files = readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
  } catch {
    return [];
  }

  const agents: RunnerAgentEntry[] = files.flatMap(f => {
    const agentId = f.replace(/\.ya?ml$/, '');
    try {
      const content = readFileSync(join(agentsDir, f), 'utf-8');
      const raw = extractYamlFields(content, ['name', 'model']);
      const modelRaw = raw['model'] ?? 'sonnet';
      const model: 'opus' | 'sonnet' | 'haiku' =
        modelRaw === 'opus' || modelRaw === 'haiku' ? modelRaw : 'sonnet';
      return [{ agentId, name: raw['name'] ?? agentId, model }];
    } catch {
      return [];
    }
  });

  const tierOrder: Record<string, number> = { opus: 0, sonnet: 1, haiku: 2 };
  agents.sort(
    (a, b) =>
      (tierOrder[a.model] ?? 1) - (tierOrder[b.model] ?? 1) ||
      a.agentId.localeCompare(b.agentId),
  );

  return agents;
}

export const load: PageServerLoad = () => {
  const agents = _loadRunnerAgents(findProjectRoot());
  return { agents };
};
