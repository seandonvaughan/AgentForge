import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSpendReport } from '../spend-report.js';

let tmpRoot: string;
const cycleId = 'peritem-reconciliation-cycle';

function cycleDir(): string {
  return join(tmpRoot, '.agentforge', 'cycles', cycleId);
}

function phasesDir(): string {
  return join(cycleDir(), 'phases');
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-spend-peritem-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('buildSpendReport per-item reconciliation', () => {
  it('reports plannedUsd from plan items and actualUsd from live itemResults', () => {
    writeJson(join(cycleDir(), 'plan.json'), {
      version: '1.0.0',
      items: [
        { id: 'child-7', title: 'route spend report', estimatedCostUsd: 3.25 },
        { id: 'child-19', title: 'dashboard spend table', estimatedCostUsd: 4.75 },
        { id: 'child-21', title: 'missing actual', estimatedCostUsd: 1.5 },
      ],
    });
    writeJson(join(phasesDir(), 'execute.json'), {
      phase: 'execute',
      status: 'completed',
      costUsd: 5.5,
      itemResults: [
        { itemId: 'child-7', status: 'completed', costUsd: 2.25 },
        { itemId: 'child-19', status: 'failed', costUsd: 3.25 },
      ],
      agentRuns: [
        { itemId: 'child-7', status: 'completed', costUsd: 99 },
        { itemId: 'child-19', status: 'completed', costUsd: 99 },
      ],
    });
    writeJson(join(phasesDir(), 'audit.json'), { phase: 'audit', costUsd: 0.5 });
    writeJson(join(phasesDir(), 'plan.json'), { phase: 'plan', costUsd: 1 });
    writeJson(join(phasesDir(), 'assign.json'), { phase: 'assign', costUsd: 0.25 });
    writeJson(join(phasesDir(), 'gate.json'), { phase: 'gate', costUsd: 0.75 });

    const report = buildSpendReport({ projectRoot: tmpRoot, cycleId, budgetUsd: 10 });

    expect(report).not.toBeNull();
    expect(report!.executionUsd).toBe(5.5);
    expect(report!.overheadUsd).toBe(2.5);
    expect(report!.totalUsd).toBe(8);
    expect(report!.utilization).toBeCloseTo(0.8, 6);
    expect(report!.perItem).toEqual([
      {
        itemId: 'child-7',
        title: 'route spend report',
        plannedUsd: 3.25,
        actualUsd: 2.25,
        status: 'completed',
      },
      {
        itemId: 'child-19',
        title: 'dashboard spend table',
        plannedUsd: 4.75,
        actualUsd: 3.25,
        status: 'failed',
      },
      {
        itemId: 'child-21',
        title: 'missing actual',
        plannedUsd: 1.5,
        actualUsd: 0,
        status: 'unknown',
      },
    ]);
  });
});
