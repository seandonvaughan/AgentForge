import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { ModelTier } from '@agentforge/shared';

interface AgentYamlRecord {
  name?: string;
  model?: string;
  description?: string;
  skills?: unknown;
  triggers?: {
    keywords?: unknown;
    file_patterns?: unknown;
  };
}

export interface CatalogAgent {
  agentId: string;
  name: string;
  model: ModelTier;
  description: string;
  skills: string[];
  keywords: string[];
  filePatterns: string[];
}

export async function listCatalogAgents(projectRoot: string): Promise<CatalogAgent[]> {
  const agentsDir = join(projectRoot, '.agentforge', 'agents');

  let files: string[];
  try {
    files = await readdir(agentsDir);
  } catch {
    return [];
  }

  const agents: CatalogAgent[] = [];
  for (const file of files.filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml')).sort()) {
    try {
      const raw = await readFile(join(agentsDir, file), 'utf8');
      const parsed = yaml.load(raw) as AgentYamlRecord | undefined;
      const agentId = file.replace(/\.(yaml|yml)$/i, '');
      agents.push({
        agentId,
        name: parsed?.name ?? agentId,
        model: normalizeModel(parsed?.model),
        description: parsed?.description ?? '',
        skills: toStringArray(parsed?.skills),
        keywords: toStringArray(parsed?.triggers?.keywords),
        filePatterns: toStringArray(parsed?.triggers?.file_patterns),
      });
    } catch {
      // Skip malformed agent files so one bad yaml does not break the catalog.
    }
  }

  return agents;
}

export function resolveCatalogAgent(
  requestedAgent: string,
  agents: CatalogAgent[],
): CatalogAgent | null {
  const normalizedRequested = normalizeAgentIdentifier(requestedAgent);
  return (
    agents.find((agent) => normalizeAgentIdentifier(agent.agentId) === normalizedRequested) ??
    agents.find((agent) => normalizeAgentIdentifier(agent.name) === normalizedRequested) ??
    null
  );
}

export function normalizeAgentIdentifier(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, '-');
}

function normalizeModel(model?: string): ModelTier {
  if (model === 'opus' || model === 'haiku') return model;
  return 'sonnet';
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
