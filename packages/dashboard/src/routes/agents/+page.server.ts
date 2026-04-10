/**
 * Server-side load for /agents.
 *
 * Reads .agentforge/agents/*.yaml directly from the filesystem so the page
 * renders with real agent data on the first request — no dependency on the
 * external backend server at port 4750.
 *
 * Uses a built-in minimal YAML field extractor instead of js-yaml to avoid
 * adding a dependency that isn't available in this package's node_modules.
 */
import type { PageServerLoad } from './$types';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface AgentListItem {
  agentId: string;
  name: string;
  model: 'opus' | 'sonnet' | 'haiku';
  description: string | null;
  role: string | null;
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
 * This is intentionally narrow — agent YAMLs only need a handful of top-level
 * string fields and this avoids a js-yaml dependency in the dashboard package.
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

    // Match a top-level key (no leading whitespace)
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)/);
    if (!m) { i++; continue; }

    const key = m[1];
    const rest = m[2].trim();

    if (!wanted.has(key)) { i++; continue; }

    if (rest === '>' || rest === '|') {
      // Block scalar: collect subsequent indented lines
      const scalar = rest;
      const parts: string[] = [];
      i++;
      while (i < lines.length && /^[ \t]/.test(lines[i])) {
        parts.push(lines[i].trim());
        i++;
      }
      result[key] = scalar === '>'
        ? parts.join(' ')          // folded: join with space
        : parts.join('\n');        // literal: preserve newlines
    } else if (rest !== '') {
      // Inline value — strip optional surrounding quotes
      result[key] = rest.replace(/^["']|["']$/g, '');
      i++;
    } else {
      i++;
    }
  }

  return result;
}

/** Walk up from CWD until we find a directory that contains .agentforge/agents/. */
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

export const load: PageServerLoad = () => {
  const root = findProjectRoot();
  const agentsDir = join(root, '.agentforge', 'agents');

  if (!existsSync(agentsDir)) return { agents: [] as AgentListItem[] };

  let files: string[] = [];
  try {
    files = readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
  } catch {
    return { agents: [] as AgentListItem[] };
  }

  const agents: AgentListItem[] = files.flatMap(f => {
    const agentId = f.replace(/\.ya?ml$/, '');
    try {
      const content = readFileSync(join(agentsDir, f), 'utf-8');
      const raw = extractYamlFields(content, ['name', 'model', 'description', 'role']);
      const modelRaw = raw.model ?? 'sonnet';
      const model: 'opus' | 'sonnet' | 'haiku' =
        modelRaw === 'opus' || modelRaw === 'haiku' ? modelRaw : 'sonnet';
      return [{
        agentId,
        name: raw.name ?? agentId,
        model,
        description: raw.description?.trim() ?? null,
        role: raw.role ?? null,
      }];
    } catch {
      return [];
    }
  });

  agents.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return { agents };
};
