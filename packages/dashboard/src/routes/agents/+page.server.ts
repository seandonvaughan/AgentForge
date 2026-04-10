/**
 * Server-side load for /agents.
 *
 * Reads .agentforge/agents/*.yaml directly from the filesystem so the page
 * renders with real agent data on the first request — no dependency on the
 * external backend server at port 4750.
 */
import type { PageServerLoad } from './$types';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export interface AgentListItem {
  agentId: string;
  name: string;
  model: 'opus' | 'sonnet' | 'haiku';
  description: string | null;
  role: string | null;
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
      const raw = yaml.load(readFileSync(join(agentsDir, f), 'utf-8')) as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object') return [];
      const modelRaw = typeof raw.model === 'string' ? raw.model : 'sonnet';
      const model: 'opus' | 'sonnet' | 'haiku' =
        modelRaw === 'opus' || modelRaw === 'haiku' ? modelRaw : 'sonnet';
      return [{
        agentId,
        name: typeof raw.name === 'string' ? raw.name : agentId,
        model,
        description: typeof raw.description === 'string' ? raw.description.trim() : null,
        role: typeof raw.role === 'string' ? raw.role : null,
      }];
    } catch {
      return [];
    }
  });

  agents.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return { agents };
};
