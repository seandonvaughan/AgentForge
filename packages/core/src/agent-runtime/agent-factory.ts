import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRuntimeConfig } from './types.js';
import type { ModelTier } from '@agentforge/shared';

interface AgentYaml {
  name?: string;
  model?: string;
  system_prompt?: string;
  role?: string;
}

export async function loadAgentConfig(
  agentId: string,
  agentforgeDir: string,
): Promise<AgentRuntimeConfig | null> {
  try {
    // Dynamically import js-yaml
    const yaml = await import('js-yaml');
    const raw = await readFile(join(agentforgeDir, 'agents', `${agentId}.yaml`), 'utf-8');
    const parsed = yaml.load(raw) as AgentYaml;

    const modelMap: Record<string, ModelTier> = {
      opus: 'opus', sonnet: 'sonnet', haiku: 'haiku',
    };

    return {
      agentId,
      name: parsed.name ?? agentId,
      model: modelMap[parsed.model ?? 'sonnet'] ?? 'sonnet',
      systemPrompt: parsed.system_prompt ?? `You are ${parsed.name ?? agentId}, an AI agent.`,
      workspaceId: 'default',
    };
  } catch {
    return null;
  }
}
