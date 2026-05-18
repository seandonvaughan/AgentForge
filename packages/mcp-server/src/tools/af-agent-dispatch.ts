/**
 * af_agent_dispatch — look up the best agent for a set of capability tags.
 *
 * Reads .agentforge/routing-index.json and returns a dispatch handle.
 * Does NOT execute anything — execution stays in the AgentForge runtime.
 *
 * SECURITY: All user-supplied tag strings are validated before use.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const AfAgentDispatchInput = z.object({
  capability_tags: z.array(z.string().min(1).max(128)).min(1).max(20),
});

export type AfAgentDispatchInputType = z.infer<typeof AfAgentDispatchInput>;

export interface AfAgentDispatchResult {
  ok: boolean;
  data: {
    agentId: string;
    ownsSubsystems: string[];
    recommendedModel: 'opus' | 'sonnet' | 'haiku';
    capabilityTags: string[];
  } | null;
  error: { code: string; message: string } | null;
}

interface RoutingAgent {
  id: string;
  capability_tags?: string[];
  owns_subsystems?: string[];
  tier?: string;
  priority?: number;
}

interface RoutingIndex {
  agents: RoutingAgent[];
}

function tierToModel(tier: string | undefined): 'opus' | 'sonnet' | 'haiku' {
  if (tier === 'opus') return 'opus';
  if (tier === 'haiku') return 'haiku';
  return 'sonnet';
}

/** Validate a single capability tag — alphanumerics, dashes, dots, underscores only. */
function validateTag(tag: string): string | null {
  const m = tag.match(/^[a-z0-9_.-]{1,128}$/i);
  return m ? m[0] : null;
}

export function afAgentDispatch(
  input: AfAgentDispatchInputType,
  projectRoot?: string,
): AfAgentDispatchResult {
  // Validate all tags (match-then-use)
  const safeTags: string[] = [];
  for (const raw of input.capability_tags) {
    const safe = validateTag(raw);
    if (!safe) {
      return {
        ok: false,
        data: null,
        error: { code: 'INVALID_TAG', message: `Invalid capability tag: "${raw}"` },
      };
    }
    safeTags.push(safe.toLowerCase());
  }

  const root = projectRoot ?? process.cwd();
  const indexPath = join(root, '.agentforge', 'routing-index.json');

  if (!existsSync(indexPath)) {
    return {
      ok: false,
      data: null,
      error: { code: 'NO_ROUTING_INDEX', message: 'Routing index not found — run `agentforge team forge` first' },
    };
  }

  let index: RoutingIndex;
  try {
    const raw = readFileSync(indexPath, 'utf-8');
    index = JSON.parse(raw) as RoutingIndex;
  } catch {
    return {
      ok: false,
      data: null,
      error: { code: 'ROUTING_INDEX_PARSE_ERROR', message: 'Failed to parse routing index' },
    };
  }

  if (!Array.isArray(index.agents) || index.agents.length === 0) {
    return {
      ok: false,
      data: null,
      error: { code: 'EMPTY_ROUTING_INDEX', message: 'Routing index has no agents' },
    };
  }

  // Score each agent by number of matching capability tags, weighted by priority
  let best: RoutingAgent | null = null;
  let bestScore = -1;

  for (const agent of index.agents) {
    const agentTags = (agent.capability_tags ?? []).map(t => t.toLowerCase());
    const matchCount = safeTags.filter(t => agentTags.includes(t)).length;
    if (matchCount === 0) continue;

    // Score = matches * 100 + priority (lower priority number = higher priority)
    const priority = agent.priority ?? 50;
    const score = matchCount * 100 + (100 - Math.min(priority, 100));

    if (score > bestScore) {
      bestScore = score;
      best = agent;
    }
  }

  if (!best) {
    return {
      ok: false,
      data: null,
      error: { code: 'NO_MATCH', message: `No agent found matching tags: ${safeTags.join(', ')}` },
    };
  }

  return {
    ok: true,
    data: {
      agentId: best.id,
      ownsSubsystems: best.owns_subsystems ?? [],
      recommendedModel: tierToModel(best.tier),
      capabilityTags: best.capability_tags ?? [],
    },
    error: null,
  };
}
