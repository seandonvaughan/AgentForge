import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordManualInvokeMemory } from '../invoke-service.js';
import type { CatalogAgent } from '../agent-catalog.js';
import type { RunResult } from '../../agent-runtime/index.js';

let tmpRoot: string | null = null;

function makeRoot(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-manual-memory-'));
  return tmpRoot;
}

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
});

const agent: CatalogAgent = {
  agentId: 'memory-curator',
  name: 'Memory Curator',
  model: 'haiku',
  description: '',
  skills: ['memory', 'runtime'],
  keywords: [],
  filePatterns: [],
};

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    sessionId: 'session-1',
    response: JSON.stringify({
      summary: 'Always preserve manual invoke outcomes in canonical memory.',
    }),
    model: 'gpt-5.4-mini',
    capabilityTier: 'haiku',
    effort: 'medium',
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.01,
    startedAt: '2026-05-25T00:00:00.000Z',
    completedAt: '2026-05-25T00:01:00.000Z',
    status: 'completed',
    providerKind: 'codex-cli',
    runtimeModeResolved: 'codex-cli',
    ...overrides,
  };
}

function readJsonl(root: string, type: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(root, '.agentforge', 'memory', `${type}.jsonl`), 'utf8');
  return raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('recordManualInvokeMemory', () => {
  it('writes completed manual invokes to learned-fact JSONL', () => {
    const root = makeRoot();

    const entry = recordManualInvokeMemory({
      projectRoot: root,
      agent,
      task: 'Audit manual memory writes.',
      result: makeResult(),
    });

    expect(entry.type).toBe('learned-fact');
    expect(entry.source).toBe('memory-curator');
    expect(entry.tags).toContain('manual-invoke');
    expect(entry.tags).toContain('memory');

    const [stored] = readJsonl(root, 'learned-fact');
    expect(stored?.id).toBe(entry.id);
    const value = JSON.parse(stored?.['value'] as string) as Record<string, unknown>;
    expect(value['lesson']).toBe('Always preserve manual invoke outcomes in canonical memory.');
    expect((stored?.['metadata'] as Record<string, unknown>)['severity']).toBe('MINOR');
  });

  it('writes failed manual invokes to failure-pattern JSONL', () => {
    const root = makeRoot();

    const entry = recordManualInvokeMemory({
      projectRoot: root,
      agent,
      task: 'Run a failing agent.',
      error: 'Codex CLI exited 1',
    });

    expect(entry.type).toBe('failure-pattern');

    const [stored] = readJsonl(root, 'failure-pattern');
    const value = JSON.parse(stored?.['value'] as string) as Record<string, unknown>;
    expect(value['status']).toBe('failed');
    expect(value['error']).toBe('Codex CLI exited 1');
    expect((stored?.['metadata'] as Record<string, unknown>)['severity']).toBe('MAJOR');
  });
});
