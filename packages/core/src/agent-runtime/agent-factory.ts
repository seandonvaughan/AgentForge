import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRuntimeConfig } from './types.js';
import type { ModelTier } from '@agentforge/shared';
import { injectFreshContext } from './fresh-context.js';

interface AgentYaml {
  name?: string;
  model?: string;
  system_prompt?: string;
  role?: string;
}

export interface LoadAgentConfigOptions {
  /**
   * When true (default), append a "Fresh Context (this cycle)" section to the
   * system prompt with the most-relevant recent memory entries for this agent.
   * Set to false in tests or when bypass is desired.
   */
  injectFreshContext?: boolean;
}

export async function loadAgentConfig(
  agentId: string,
  agentforgeDir: string,
  options: LoadAgentConfigOptions = {},
): Promise<AgentRuntimeConfig | null> {
  try {
    // Dynamically import js-yaml
    const yaml = await import('js-yaml');
    const raw = await readFile(join(agentforgeDir, 'agents', `${agentId}.yaml`), 'utf-8');
    const parsed = yaml.load(raw) as AgentYaml;

    const modelMap: Record<string, ModelTier> = {
      opus: 'opus', sonnet: 'sonnet', haiku: 'haiku',
    };

    const baseSystemPrompt =
      parsed.system_prompt ?? `You are ${parsed.name ?? agentId}, an AI agent.`;

    const shouldInject = options.injectFreshContext !== false;
    const systemPrompt = shouldInject
      ? injectFreshContext(baseSystemPrompt, agentId, agentforgeDir)
      : baseSystemPrompt;

    return {
      agentId,
      name: parsed.name ?? agentId,
      model: modelMap[parsed.model ?? 'sonnet'] ?? 'sonnet',
      systemPrompt,
      workspaceId: 'default',
    };
  } catch {
    return null;
  }
}
