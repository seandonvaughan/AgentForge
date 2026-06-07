import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildDecompositionView } from '../decomposition-view.js';

let tmpRoot: string;
const cycleId = '33333333-3333-3333-3333-333333333333';

function cycleDir(): string {
  return join(tmpRoot, '.agentforge', 'cycles', cycleId);
}

function phasesDir(): string {
  return join(cycleDir(), 'phases');
}

function child(id: string, wave: number): Record<string, unknown> {
  return {
    id,
    title: `Child ${id}`,
    description: `Do ${id}`,
    files: [`src/${id}.ts`],
    capabilityTags: ['runtime'],
    suggestedAssignee: 'executor-runtime-engineer',
    estimatedCostUsd: 1,
    estimatedComplexity: 'low',
    predecessors: [],
    wave,
  };
}

function writeDecomposition(children: Record<string, unknown>[]): void {
  mkdirSync(cycleDir(), { recursive: true });
  writeFileSync(
    join(cycleDir(), 'decomposition.json'),
    JSON.stringify({
      epicId: 'epic-33333333',
      rationale: 'Split by dependency wave.',
      children,
      validationReport: {
        acyclic: true,
        missingPredecessors: [],
        syntheticFileEdges: [],
        waveCount: 2,
      },
    }),
  );
}

function writeExecute(itemResults: Record<string, unknown>[]): void {
  mkdirSync(phasesDir(), { recursive: true });
  writeFileSync(
    join(phasesDir(), 'execute.json'),
    JSON.stringify({ phase: 'execute', status: 'completed', itemResults }),
  );
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-decomposition-view-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('buildDecompositionView', () => {
  it('defaults children to pending with zero actual cost when execute results are absent', () => {
    writeDecomposition([child('child-1', 0)]);

    const view = buildDecompositionView({ projectRoot: tmpRoot, cycleId });

    expect(view).not.toBeNull();
    expect(view!.waves).toEqual([
      {
        wave: 0,
        children: [
          expect.objectContaining({
            id: 'child-1',
            status: 'pending',
            actualCostUsd: 0,
          }),
        ],
      },
    ]);
  });

  it('merges partial execute itemResults and leaves missing children pending', () => {
    writeDecomposition([child('child-1', 0), child('child-2', 0)]);
    writeExecute([{ itemId: 'child-1', status: 'completed', costUsd: 2.75 }]);

    const view = buildDecompositionView({ projectRoot: tmpRoot, cycleId });

    const waveChildren = view!.waves[0]!.children;
    expect(waveChildren).toEqual([
      expect.objectContaining({
        id: 'child-1',
        status: 'completed',
        actualCostUsd: 2.75,
      }),
      expect.objectContaining({
        id: 'child-2',
        status: 'pending',
        actualCostUsd: 0,
      }),
    ]);
  });

  it('groups children by wave in ascending wave order', () => {
    writeDecomposition([
      child('child-2a', 2),
      child('child-0', 0),
      child('child-2b', 2),
      child('child-1', 1),
    ]);

    const view = buildDecompositionView({ projectRoot: tmpRoot, cycleId });

    expect(view!.waves.map((wave) => wave.wave)).toEqual([0, 1, 2]);
    expect(view!.waves.map((wave) => wave.children.map((c) => c.id))).toEqual([
      ['child-0'],
      ['child-1'],
      ['child-2a', 'child-2b'],
    ]);
  });
});
