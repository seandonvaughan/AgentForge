// G2 — af_agent_memory MCP tool: per-agent W2 memory reader
// (.agentforge/memory/agents/<agentId>.jsonl), mirroring core
// readAgentMemoryFromDir semantics (newest first, corrupt lines skipped).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afAgentMemory } from '../af-agent-memory.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'af-mcp-agent-memory-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeAgentMemory(agentId: string, lines: string[]): void {
  const dir = join(root, '.agentforge', 'memory', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agentId}.jsonl`), lines.join('\n') + '\n', 'utf8');
}

it('returns entries newest first, bounded by limit', () => {
  writeAgentMemory('epic-planner', [
    JSON.stringify({ id: '1', createdAt: '2026-06-01T00:00:00Z', kind: 'item-outcome', value: 'oldest' }),
    JSON.stringify({ id: '2', createdAt: '2026-06-02T00:00:00Z', kind: 'self-note', value: 'middle' }),
    JSON.stringify({ id: '3', createdAt: '2026-06-03T00:00:00Z', kind: 'self-note', value: 'newest' }),
  ]);

  const result = afAgentMemory({ agentId: 'epic-planner', limit: 2 }, root);
  expect(result.ok).toBe(true);
  expect(result.data!.agentId).toBe('epic-planner');
  expect(result.data!.totalEntries).toBe(3);
  expect(result.data!.entries.map((e) => e.value)).toEqual(['newest', 'middle']);
});

it('skips corrupt and value-less lines', () => {
  writeAgentMemory('coder', [
    '{not json',
    JSON.stringify({ id: '1', value: '' }),
    JSON.stringify({ id: '2', value: 'kept', kind: 'self-note' }),
  ]);

  const result = afAgentMemory({ agentId: 'coder' }, root);
  expect(result.ok).toBe(true);
  expect(result.data!.totalEntries).toBe(1);
  expect(result.data!.entries[0]!.value).toBe('kept');
});

it('returns a clean error when the agent has no memory file', () => {
  const result = afAgentMemory({ agentId: 'ghost-agent' }, root);
  expect(result.ok).toBe(false);
  expect(result.error!.code).toBe('AGENT_MEMORY_NOT_FOUND');
  expect(result.error!.message).toBe(
    'No personal memory recorded for agent ghost-agent (.agentforge/memory/agents/ghost-agent.jsonl is missing)',
  );
});

it('rejects a traversal agentId before touching the filesystem', () => {
  const result = afAgentMemory({ agentId: '../../memory/agents/coder' }, root);
  expect(result.ok).toBe(false);
  expect(result.error!.code).toBe('INVALID_AGENT_ID');
});

it('rejects an agentId with a path separator', () => {
  const result = afAgentMemory({ agentId: 'a/b' }, root);
  expect(result.ok).toBe(false);
  expect(result.error!.code).toBe('INVALID_AGENT_ID');
});
