// spend-report-fields.test.ts
//
// Asserts that the JSON written to spend-report.json includes the exact
// fields that the dashboard Spend tab (child-16) expects:
//   - perItem[]: { itemId, plannedUsd, actualUsd }
//   - top-level: executionUsd, overheadUsd, utilization
//
// These are the fields documented in SpendReportArtifact / SpendReport.
// Tests read from disk (not just in-memory) to validate the emitted artifact.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildSpendReport,
  writeSpendReport,
  type SpendReportArtifact,
} from '../spend-report.js';

let tmpRoot: string;
const cycleId = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';

function cycleDir(): string {
  return join(tmpRoot, '.agentforge', 'cycles', cycleId);
}
function phasesDir(): string {
  return join(cycleDir(), 'phases');
}

function writePlan(
  items: Array<{ id: string; title: string; estimatedCostUsd?: number; status?: string }>,
): void {
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
      })),
    }),
  );
}

function writePhase(name: string, body: Record<string, unknown>): void {
  mkdirSync(phasesDir(), { recursive: true });
  writeFileSync(join(phasesDir(), `${name}.json`), JSON.stringify(body));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'af-spend-fields-'));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('spend-report.json emitted shape — SpendReportArtifact fields', () => {
  it('written JSON contains perItem with itemId, plannedUsd, actualUsd for each plan item', () => {
    writePlan([
      { id: 'item-1', title: 'Feature A', estimatedCostUsd: 3 },
      { id: 'item-2', title: 'Feature B' }, // no estimate → plannedUsd null
    ]);
    writePhase('execute', {
      phase: 'execute',
      costUsd: 7,
      itemResults: [
        { itemId: 'item-1', costUsd: 4.5, status: 'completed' },
        { itemId: 'item-2', costUsd: 2.5, status: 'completed' },
      ],
    });
    writePhase('audit', { costUsd: 1 });
    writePhase('plan', { costUsd: 0.5 });

    const report = buildSpendReport({ projectRoot: tmpRoot, cycleId, budgetUsd: 25 });
    expect(report).not.toBeNull();
    writeSpendReport(tmpRoot, cycleId, report!);

    const path = join(cycleDir(), 'spend-report.json');
    const artifact = JSON.parse(readFileSync(path, 'utf8')) as SpendReportArtifact;

    // perItem shape
    expect(Array.isArray(artifact.perItem)).toBe(true);
    expect(artifact.perItem).toHaveLength(2);

    const a = artifact.perItem.find((p) => p.itemId === 'item-1')!;
    expect(a).toBeDefined();
    expect(a.itemId).toBe('item-1');
    expect(a.plannedUsd).toBe(3);
    expect(a.actualUsd).toBe(4.5);

    const b = artifact.perItem.find((p) => p.itemId === 'item-2')!;
    expect(b).toBeDefined();
    expect(b.itemId).toBe('item-2');
    expect(b.plannedUsd).toBeNull(); // no estimate
    expect(b.actualUsd).toBe(2.5);
  });

  it('written JSON contains executionUsd, overheadUsd, and utilization totals', () => {
    writePlan([{ id: 'item-1', title: 'Task', estimatedCostUsd: 5 }]);
    writePhase('execute', {
      phase: 'execute',
      costUsd: 8,
      itemResults: [{ itemId: 'item-1', costUsd: 8, status: 'completed' }],
    });
    writePhase('audit', { costUsd: 1 });
    writePhase('review', { costUsd: 1 });

    const report = buildSpendReport({ projectRoot: tmpRoot, cycleId, budgetUsd: 20 });
    expect(report).not.toBeNull();
    writeSpendReport(tmpRoot, cycleId, report!);

    const path = join(cycleDir(), 'spend-report.json');
    const artifact = JSON.parse(readFileSync(path, 'utf8')) as SpendReportArtifact;

    expect(typeof artifact.executionUsd).toBe('number');
    expect(artifact.executionUsd).toBe(8);

    expect(typeof artifact.overheadUsd).toBe('number');
    expect(artifact.overheadUsd).toBe(2); // audit(1) + review(1)

    expect(typeof artifact.utilization).toBe('number');
    // totalUsd = 10; budgetUsd = 20 → 0.5
    expect(artifact.utilization).toBeCloseTo(0.5, 6);

    expect(artifact.totalUsd).toBe(10);
    expect(artifact.budgetUsd).toBe(20);
  });

  it('written JSON contains schemaVersion, cycleId, and generatedAt', () => {
    writePlan([{ id: 'item-x', title: 'X' }]);
    writePhase('execute', {
      phase: 'execute',
      costUsd: 1,
      itemResults: [{ itemId: 'item-x', costUsd: 1, status: 'completed' }],
    });

    const report = buildSpendReport({ projectRoot: tmpRoot, cycleId, budgetUsd: 10 });
    expect(report).not.toBeNull();
    writeSpendReport(tmpRoot, cycleId, report!);

    const path = join(cycleDir(), 'spend-report.json');
    const artifact = JSON.parse(readFileSync(path, 'utf8')) as SpendReportArtifact;

    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.cycleId).toBe(cycleId);
    expect(typeof artifact.generatedAt).toBe('string');
    // generatedAt must be a parseable ISO timestamp
    expect(Number.isNaN(Date.parse(artifact.generatedAt))).toBe(false);
  });

  it('writeSpendReport is best-effort — never throws on an unwritable path', () => {
    // Build a minimal report without touching disk paths.
    writePlan([{ id: 'item-1', title: 'T' }]);
    writePhase('execute', { costUsd: 1, itemResults: [] });
    const report = buildSpendReport({ projectRoot: tmpRoot, cycleId, budgetUsd: 5 })!;

    // Pass a non-existent / unwritable root — must not throw.
    expect(() => writeSpendReport('/nonexistent-root-12345', 'fake-cycle', report)).not.toThrow();
  });
});
