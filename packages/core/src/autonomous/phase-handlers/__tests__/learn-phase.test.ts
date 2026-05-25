import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runLearnPhase } from '../learn-phase.js';
import type { PhaseContext } from '../../phase-scheduler.js';

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

describe('learn phase', () => {
  it('uses real cycle artifacts and writes cycle-scoped learned facts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentforge-learn-phase-'));
    const cycleId = 'cycle-learn-1';
    const cycleDir = join(root, '.agentforge', 'cycles', cycleId);
    const phasesDir = join(cycleDir, 'phases');
    let capturedTask = '';

    try {
      mkdirSync(phasesDir, { recursive: true });
      writeJson(join(cycleDir, 'plan.json'), {
        items: [{ id: 'item-a', title: 'Parallel verifier', assignee: 'executor-runtime-engineer' }],
      });
      writeJson(join(phasesDir, 'execute.json'), {
        status: 'completed',
        agentRuns: [
          {
            itemId: 'item-a',
            agentId: 'executor-runtime-engineer',
            status: 'completed',
            worktreeBranch: 'codex/agent-executor-runtime-engineer-abc',
            response: 'Added bounded parallel branch verification.',
          },
        ],
      });
      writeJson(join(phasesDir, 'gate.json'), {
        status: 'completed',
        agentRuns: [{ agentId: 'ceo', verdict: 'APPROVE', response: 'APPROVE: branch checks passed.' }],
      });
      writeJson(join(cycleDir, 'tests.json'), { passed: 12, failed: 0, total: 12 });
      writeFileSync(join(cycleDir, 'events.jsonl'), [
        JSON.stringify({ type: 'phase.start', phase: 'execute' }),
        JSON.stringify({ type: 'cycle_event', category: 'item.completed', payload: { itemId: 'item-a' } }),
      ].join('\n'), 'utf8');

      const ctx: PhaseContext = {
        sprintId: 'sprint-learn',
        sprintVersion: '10.42.0',
        projectRoot: root,
        adapter: {},
        bus: {
          publish: () => undefined,
          subscribe: () => () => undefined,
        },
        runtime: {
          run: async (_agentId: string, task: string) => {
            capturedTask = task;
            return {
              output: [
                '# Recommendations',
                '- Use bounded parallel branch verification with serialized git worktree mutations.',
              ].join('\n'),
              costUsd: 0.01,
            };
          },
        },
        cycleId,
      };

      const result = await runLearnPhase(ctx);

      expect(result.status).toBe('completed');
      expect(capturedTask).toContain('item-a');
      expect(capturedTask).toContain('executor-runtime-engineer');
      expect(capturedTask).toContain('APPROVE');
      const memoryPath = join(root, '.agentforge', 'memory', 'learned-fact.jsonl');
      const entries = readFileSync(memoryPath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as Record<string, any>);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'learned-fact',
            source: 'executor-runtime-engineer',
            value: 'Use bounded parallel branch verification with serialized git worktree mutations.',
            metadata: expect.objectContaining({
              cycleId,
              sprintVersion: '10.42.0',
              agentId: 'executor-runtime-engineer',
            }),
          }),
        ]),
      );
      expect(readFileSync(join(cycleDir, 'retrospective.md'), 'utf8')).toContain('bounded parallel');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
