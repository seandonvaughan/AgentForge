/**
 * Server-side load for /runner.
 *
 * Reads .agentforge/agents/*.yaml directly from the filesystem so the agent
 * selector renders with real data on the first request — no dependency on the
 * external backend server at port 4750 for the initial render.
 *
 * Exports _loadRunnerAgents(root) for hermetic unit tests (same convention as
 * agents/+page.server.ts#_loadAgents and flywheel/+page.server.ts#_computeMetrics).
 */
import type { PageServerLoad } from './$types';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export interface RunnerAgentEntry {
  agentId: string;
  name: string;
  model: 'opus' | 'sonnet' | 'haiku';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
      const raw = asRecord(yaml.load(content));
      const modelRaw = typeof raw.model === 'string' ? raw.model : 'sonnet';
      const model: 'opus' | 'sonnet' | 'haiku' =
        modelRaw === 'opus' || modelRaw === 'haiku' ? modelRaw : 'sonnet';
      return [{ agentId, name: typeof raw.name === 'string' ? raw.name : agentId, model }];
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
