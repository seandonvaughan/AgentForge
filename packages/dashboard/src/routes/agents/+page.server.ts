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
import type { AgentListItem } from './agents-utils.js';
import { resolveDashboardCodexProfile } from './codex-profile.server.js';
export type { AgentListItem } from './agents-utils.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

/**
 * Core data-loading logic extracted so it can be unit-tested independently.
 *
 * Reads every *.yaml file under `<root>/.agentforge/agents/`, extracts the
 * top-level fields used by the dashboard list view, and returns a sorted array
 * of AgentListItem.  Malformed or unreadable files are silently skipped.
 *
 * Follows the same `_helperName(projectRoot)` export convention used by
 * org/+page.server.ts (_buildOrgGraph) and flywheel/+page.server.ts
 * (_computeMetrics) so hermetic unit tests can exercise the SSR path.
 */
export function _loadAgents(root: string): AgentListItem[] {
  const agentsDir = join(root, '.agentforge', 'agents');

  if (!existsSync(agentsDir)) return [];

  let files: string[] = [];
  try {
    files = readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
  } catch {
    return [];
  }

  const agents: AgentListItem[] = files.flatMap(f => {
    const agentId = f.replace(/\.ya?ml$/, '');
    try {
      const content = readFileSync(join(agentsDir, f), 'utf-8');
      const raw = asRecord(yaml.load(content));
      const modelRaw = typeof raw.model === 'string' ? raw.model : 'sonnet';
      const model: 'opus' | 'sonnet' | 'haiku' =
        modelRaw === 'opus' || modelRaw === 'haiku' ? modelRaw : 'sonnet';
      const effort = typeof raw.effort === 'string' ? raw.effort : null;
      return [{
        agentId,
        name: typeof raw.name === 'string' ? raw.name : agentId,
        model,
        capabilityTier: model,
        modelProfile: resolveDashboardCodexProfile(root, model, effort),
        description: typeof raw.description === 'string' ? raw.description.trim() : null,
        role: typeof raw.role === 'string' ? raw.role : null,
        team: typeof raw.team === 'string' ? raw.team : null,
        effort,
      }];
    } catch {
      return [];
    }
  });

  agents.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return agents;
}


export const load: PageServerLoad = () => {
  const agents = _loadAgents(findProjectRoot());
  return { agents };
};
