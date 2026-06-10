// P0.8 — spend-report tests. Covers report math (utilization,
// execution/overhead split, null planned), markdown rendering, ledger append,
// completed snapshot, and the all-unreadable → null contract.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildSpendReport,
  writeSpendReport,
  renderSpendReportMarkdown,
  appendLedgerRow,
  writeCompletedSnapshot,
  type SpendReport,
  type CycleLedgerRow,
} from '../spend-report.js';

let tmpRoot: string;
const cycleId = '22222222-2222-2222-2222-222222222222';

function cycleDir(): string {
  return join(tmpRoot, '.agentforge', 'cycles', cycleId);
}
function phasesDir(): string {
  return join(cycleDir(), 'phases');
}

function writePlan(items: Array<{ id: string; title: string; estimatedCostUsd?: number; status?: string; estimatedComplexity?: string }>): void {
  mkdirSync(cycleDir(), { recursive: true });
  writeFileSync(
    join(cycleDir(), 'plan.json'),
    JSON.stringify({
      version: '1.0.0',
      items: items.map((i) => ({
        id: i.id,
        title: i.title,
        ...(i.estimatedCostUsd !== undefined ? { estimatedCostUsd: i.estimatedCostUsd } : {}),
        ...(i.status !== undefined ? { status: i.status } : {}),
        ...(i.estimatedComplexity !== undefined ? { estimatedComplexity: i.estimatedComplexity } : {}),
      })),
    }),
  );
}

function writePhase(name: string, body: Record<string, unknown>): void {
  mkdirSync(phasesDir(), { recursive: true });
  writeFileSync(join(phasesDir(), `${name}.json`), JSON.stringify(body));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-spend-'));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('buildSpendReport — math', () => {
  it('splits execution vs overhead and computes utilization', () => {
    writePlan([
      { id: 'i1', title: 'one', estimatedCostUsd: 2 },
      { id: 'i2', title: 'two' }, // no estimate → plannedUsd null
    ]);
    writePhase('execute', {
      phase: 'execute',
      costUsd: 6,
      itemResults: [
        { itemId: 'i1', costUsd: 4, status: 'completed' },
        { itemId: 'i2', costUsd: 2, status: 'failed' },
      ],
    });
    writePhase('audit', { costUsd: 1 });
    writePhase('plan', { costUsd: 0.5 });
    writePhase('gate', { costUsd: 0.5 });

    const report = buildSpendReport({ projectRoot: tmpRoot, cycleId, budgetUsd: 20 });
    expect(report).not.toBeNull();
    const r = report!;
    expect(r.executionUsd).toBe(6);
    expect(r.overheadUsd).toBe(2); // 1 + 0.5 + 0.5
    expect(r.totalUsd).toBe(8);
    expect(r.utilization).toBeCloseTo(8 / 20, 6);
    expect(r.perItem).toHaveLength(2);
    const i1 = r.perItem.find((p) => p.itemId === 'i1')!;
    expect(i1.plannedUsd).toBe(2);
    expect(i1.actualUsd).toBe(4);
    expect(i1.status).toBe('completed');
    const i2 = r.perItem.find((p) => p.itemId === 'i2')!;
    expect(i2.plannedUsd).toBeNull();
    expect(i2.actualUsd).toBe(2);
    expect(i2.status).toBe('failed');
  });

  it('W3: per-item rows carry estimatedComplexity and estimateAccuracy', () => {
    writePlan([
      { id: 'i1', title: 'A', estimatedCostUsd: 4, estimatedComplexity: 'medium' },
      { id: 'i2', title: 'B', estimatedCostUsd: 2, estimatedComplexity: 'low' },
    ]);
    writePhase('execute', {
      costUsd: 7,
      itemResults: [
        { itemId: 'i1', status: 'completed', costUsd: 6 },
        { itemId: 'i2', status: 'failed', costUsd: 0 },
      ],
    });
    const report = buildSpendReport({ projectRoot: tmpRoot, cycleId, budgetUsd: 30 })!;
    const i1 = report.perItem.find((r) => r.itemId === 'i1')!;
    expect(i1.estimatedComplexity).toBe('medium');
    expect(i1.estimateAccuracy).toBe(1.5); // 6 actual / 4 planned
    const i2 = report.perItem.find((r) => r.itemId === 'i2')!;
    expect(i2.estimatedComplexity).toBe('low');
    expect(i2.estimateAccuracy).toBeUndefined(); // no positive actual
  });

  it('utilization is 0 when budget is 0 (no divide-by-zero)', () => {
    writePlan([{ id: 'i1', title: 'one' }]);
    writePhase('execute', { phase: 'execute', costUsd: 3, itemResults: [] });
    const r = buildSpendReport({ projectRoot: tmpRoot, cycleId, budgetUsd: 0 })!;
    expect(r.utilization).toBe(0);
    expect(r.totalUsd).toBe(3);
  });

  it('surfaces epicId from execute.json epicIntegration', () => {
    writePlan([{ id: 'i1', title: 'one' }]);
    writePhase('execute', {
      phase: 'execute',
      costUsd: 1,
      epicIntegration: { branch: 'codex/epic-z', epicId: 'epic-z' },
      itemResults: [],
    });
    const r = buildSpendReport({ projectRoot: tmpRoot, cycleId, budgetUsd: 10 })!;
    expect(r.epicId).toBe('epic-z');
  });

  it('returns a best-effort report when plan exists but execute is absent', () => {
    writePlan([{ id: 'i1', title: 'one', estimatedCostUsd: 5, status: 'completed' }]);
    const r = buildSpendReport({ projectRoot: tmpRoot, cycleId, budgetUsd: 10 })!;
    expect(r).not.toBeNull();
    expect(r.executionUsd).toBe(0);
    expect(r.perItem[0]!.plannedUsd).toBe(5);
    expect(r.perItem[0]!.actualUsd).toBe(0);
    // status falls back to the plan item's own status when no execute actual.
    expect(r.perItem[0]!.status).toBe('completed');
  });

  it('returns null when BOTH plan.json and execute.json are unreadable', () => {
    // Nothing written at all.
    const r = buildSpendReport({ projectRoot: tmpRoot, cycleId, budgetUsd: 10 });
    expect(r).toBeNull();
  });
});

describe('renderSpendReportMarkdown', () => {
  it('renders a GFM table + totals line; null planned → em dash', () => {
    const report: SpendReport = {
      schemaVersion: 1,
      cycleId,
      budgetUsd: 100,
      totalUsd: 25,
      executionUsd: 20,
      overheadUsd: 5,
      utilization: 0.25,
      perItem: [
        { itemId: 'i1', title: 'one', plannedUsd: 10, actualUsd: 12, status: 'completed' },
        { itemId: 'i2', title: 'two', plannedUsd: null, actualUsd: 8, status: 'failed' },
      ],
      generatedAt: new Date().toISOString(),
    };
    const md = renderSpendReportMarkdown(report);
    expect(md).toContain('### Spend report');
    expect(md).toContain('| Item | Planned | Actual | Status |');
    expect(md).toContain('| i1 | $10.00 | $12.00 | completed |');
    // null planned renders as em dash.
    expect(md).toContain('| i2 | — | $8.00 | failed |');
    expect(md).toContain('**Total: $25.00 of $100.00 budget (25% utilization) — execution $20.00 / overhead $5.00**');
  });

  it('renders a placeholder row when there are no items', () => {
    const report: SpendReport = {
      schemaVersion: 1,
      cycleId,
      budgetUsd: 0,
      totalUsd: 0,
      executionUsd: 0,
      overheadUsd: 0,
      utilization: 0,
      perItem: [],
      generatedAt: new Date().toISOString(),
    };
    const md = renderSpendReportMarkdown(report);
    expect(md).toContain('| (no items) | — | — | — |');
  });
});

describe('writeSpendReport', () => {
  it('writes spend-report.json and never throws on a bad path', () => {
    writePlan([{ id: 'i1', title: 'one' }]);
    const report = buildSpendReport({ projectRoot: tmpRoot, cycleId, budgetUsd: 10 })!;
    writeSpendReport(tmpRoot, cycleId, report);
    const path = join(cycleDir(), 'spend-report.json');
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.cycleId).toBe(cycleId);
  });
});

describe('appendLedgerRow', () => {
  it('appends two rows as two valid JSON lines', () => {
    const base: CycleLedgerRow = {
      schemaVersion: 1,
      cycleId,
      budgetUsd: 10,
      totalUsd: 5,
      utilization: 0.5,
      executionUsd: 4,
      overheadUsd: 1,
      items: { planned: 2, completed: 1, failed: 1 },
      completedAt: new Date().toISOString(),
    };
    appendLedgerRow(tmpRoot, base);
    appendLedgerRow(tmpRoot, { ...base, cycleId: 'other', totalUsd: 7 });

    const path = join(tmpRoot, '.agentforge', 'memory', 'cycle-ledger.jsonl');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]!);
    const b = JSON.parse(lines[1]!);
    expect(a.cycleId).toBe(cycleId);
    expect(b.cycleId).toBe('other');
    expect(b.totalUsd).toBe(7);
  });
});

describe('writeCompletedSnapshot', () => {
  it('writes completed.json pretty-printed', () => {
    const result = { cycleId, stage: 'completed', cost: { totalUsd: 3 } };
    writeCompletedSnapshot(tmpRoot, cycleId, result);
    const path = join(cycleDir(), 'completed.json');
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    // Pretty-printed → contains newlines + indentation.
    expect(raw).toContain('\n  ');
    expect(JSON.parse(raw).stage).toBe('completed');
  });
});
