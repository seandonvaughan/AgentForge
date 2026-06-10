/**
 * af_agent_memory — read an agent's personal W2 memory from
 * .agentforge/memory/agents/<agentId>.jsonl, newest first.
 *
 * @agentforge/core exports readAgentMemoryFromDir, but the mcp-server package
 * deliberately does not depend on @agentforge/core (SQLite weight — see
 * af-kb-search.ts), so this reader mirrors the read path and the containment
 * pattern of core/src/memory/agent-memory.ts — keep the two in lockstep.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';

export const AfAgentMemoryInput = z.object({
  agentId: z.string().min(1).max(64),
  limit: z.number().int().min(1).max(50).optional(),
});
export type AfAgentMemoryInputType = z.infer<typeof AfAgentMemoryInput>;

/** Mirror of core AgentMemoryEntry (memory/agent-memory.ts). */
export interface AfAgentMemoryEntry {
  id?: string;
  createdAt?: string;
  kind?: string;
  value: string;
  cycleId?: string;
  itemId?: string;
  outcome?: string;
  costUsd?: number;
  files?: string[];
  tags?: string[];
}

export interface AfAgentMemoryResult {
  ok: boolean;
  data: { agentId: string; totalEntries: number; entries: AfAgentMemoryEntry[] } | null;
  error: { code: string; message: string } | null;
}

// Match-then-use sanitizer — same SAFE_AGENT_ID as core agent-memory.ts.
const SAFE_AGENT_ID = /^[a-zA-Z0-9_-]+$/;

function parseLines(raw: string): AfAgentMemoryEntry[] {
  const out: AfAgentMemoryEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AfAgentMemoryEntry;
      if (parsed && typeof parsed.value === 'string' && parsed.value.length > 0) out.push(parsed);
    } catch { /* skip corrupt line */ }
  }
  return out;
}

export function afAgentMemory(
  input: AfAgentMemoryInputType,
  projectRoot: string,
): AfAgentMemoryResult {
  const idMatch = SAFE_AGENT_ID.exec(input.agentId);
  if (!idMatch) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'INVALID_AGENT_ID',
        message: 'agentId must be alphanumerics, dashes, underscores (≤64 chars)',
      },
    };
  }

  // Containment barrier (CodeQL js/path-injection), mirroring
  // core readAgentMemoryFromDir: resolve the joined path and require it to
  // stay under the agents dir — the prefix check gives the analyzer a
  // sanitized value to trace, and defends in depth.
  const agentsDir = resolve(projectRoot, '.agentforge', 'memory', 'agents');
  const filePath = resolve(agentsDir, `${idMatch[0]}.jsonl`);
  if (!filePath.startsWith(agentsDir + sep)) {
    return {
      ok: false,
      data: null,
      error: { code: 'INVALID_AGENT_ID', message: 'agentId resolves outside the agents memory directory' },
    };
  }

  if (!existsSync(filePath)) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'AGENT_MEMORY_NOT_FOUND',
        message: `No personal memory recorded for agent ${idMatch[0]} (.agentforge/memory/agents/${idMatch[0]}.jsonl is missing)`,
      },
    };
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: { code: 'READ_FAILED', message: err instanceof Error ? err.message : String(err) },
    };
  }

  const all = parseLines(raw);
  const limit = input.limit ?? 10;
  return {
    ok: true,
    data: {
      agentId: idMatch[0],
      totalEntries: all.length,
      // Newest first — same orientation as core readAgentMemoryFromDir.
      entries: all.slice(-limit).reverse(),
    },
    error: null,
  };
}
