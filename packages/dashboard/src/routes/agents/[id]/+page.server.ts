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
import type { CapabilityTier, CodexModelProfile } from '../agents-utils.js';
import { resolveDashboardCodexProfile } from '../codex-profile.server.js';

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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export interface AgentDetail {
  agentId: string;
  name: string;
  model: CapabilityTier;
  capabilityTier: CapabilityTier;
  modelProfile: CodexModelProfile;
  description: string | null;
  role: string | null;
  effort: string | null;
  systemPrompt: string | null;
  skills: string[];
  /** Explicit tool allowlist from YAML; empty = inherit from skills. */
  tools: string[];
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

  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(yaml.load(readFileSync(filePath, 'utf-8')));
  } catch {
    error(500, `Failed to parse agent "${id}"`);
  }

  const collab = asRecord(parsed['collaboration']);

  const modelRaw = typeof parsed['model'] === 'string' ? parsed['model'] : 'sonnet';
  const model: CapabilityTier =
    modelRaw === 'fable' || modelRaw === 'opus' || modelRaw === 'haiku' ? modelRaw : 'sonnet';
  const effort = typeof parsed['effort'] === 'string' ? parsed['effort'] : null;

  const agent: AgentDetail = {
    agentId: id,
    name: typeof parsed['name'] === 'string' ? parsed['name'] : id,
    model,
    capabilityTier: model,
    modelProfile: resolveDashboardCodexProfile(root, model, effort),
    description: typeof parsed['description'] === 'string' ? parsed['description'].trim() : null,
    role: typeof parsed['role'] === 'string' ? parsed['role'] : null,
    effort,
    systemPrompt: typeof parsed['system_prompt'] === 'string' ? parsed['system_prompt'] : null,
    skills: asStringArray(parsed['skills']),
    tools: asStringArray(parsed['tools']),
    version: typeof parsed['version'] === 'string' ? parsed['version'] : null,
    seniority: typeof parsed['seniority'] === 'string' ? parsed['seniority'] : null,
    layer: typeof parsed['layer'] === 'string' ? parsed['layer'] : null,
    reportsTo: typeof collab['reports_to'] === 'string' ? collab['reports_to'] : null,
    canDelegateTo: asStringArray(collab['can_delegate_to']),
  };

  return { agent };
};
