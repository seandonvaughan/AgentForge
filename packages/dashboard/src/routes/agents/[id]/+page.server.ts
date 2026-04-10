/**
 * Server-side load for /agents/[id].
 *
 * Reads .agentforge/agents/<id>.yaml directly so the detail page renders
 * with full agent data on first load — no dependency on the external backend.
 */
import type { PageServerLoad, PageServerLoadEvent } from './$types';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { error } from '@sveltejs/kit';
import yaml from 'js-yaml';

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

export interface AgentDetail {
  agentId: string;
  name: string;
  model: 'opus' | 'sonnet' | 'haiku';
  description: string | null;
  role: string | null;
  systemPrompt: string | null;
  skills: string[];
  version: string | null;
  seniority: string | null;
  layer: string | null;
  reportsTo: string | null;
  canDelegateTo: string[];
}

export const load: PageServerLoad = ({ params }: PageServerLoadEvent) => {
  const { id } = params;
  const root = findProjectRoot();
  const filePath = join(root, '.agentforge', 'agents', `${id}.yaml`);

  if (!existsSync(filePath)) {
    error(404, `Agent "${id}" not found`);
  }

  let raw: Record<string, unknown> | null;
  try {
    raw = yaml.load(readFileSync(filePath, 'utf-8')) as Record<string, unknown> | null;
  } catch {
    error(500, `Failed to parse agent "${id}"`);
  }

  if (!raw || typeof raw !== 'object') {
    error(404, `Agent "${id}" not found`);
  }

  const modelRaw = typeof raw.model === 'string' ? raw.model : 'sonnet';
  const model: 'opus' | 'sonnet' | 'haiku' =
    modelRaw === 'opus' || modelRaw === 'haiku' ? modelRaw : 'sonnet';

  const skillsRaw = Array.isArray(raw.skills) ? raw.skills : [];
  const skills = skillsRaw.filter((s): s is string => typeof s === 'string');

  const collabRaw =
    raw.collaboration && typeof raw.collaboration === 'object'
      ? (raw.collaboration as Record<string, unknown>)
      : {};

  const agent: AgentDetail = {
    agentId: id,
    name: typeof raw.name === 'string' ? raw.name : id,
    model,
    description: typeof raw.description === 'string' ? raw.description.trim() : null,
    role: typeof raw.role === 'string' ? raw.role : null,
    systemPrompt: typeof raw.system_prompt === 'string' ? raw.system_prompt : null,
    skills,
    version: typeof raw.version === 'string' ? raw.version : null,
    seniority: typeof raw.seniority === 'string' ? raw.seniority : null,
    layer: typeof raw.layer === 'string' ? raw.layer : null,
    reportsTo:
      typeof collabRaw.reports_to === 'string' ? collabRaw.reports_to : null,
    canDelegateTo: Array.isArray(collabRaw.can_delegate_to)
      ? collabRaw.can_delegate_to.filter((s): s is string => typeof s === 'string')
      : [],
  };

  return { agent };
};
