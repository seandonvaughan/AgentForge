import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendCycleLedgerEntry,
  readCycleLedgerEntries,
  readLedgerCostPriorActuals,
  type CycleLedgerEntry,
} from '../../../packages/core/src/autonomous/ledger.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'af-ledger-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function entry(
  status: string,
  totalUsd: number,
  actualUsd: number,
): CycleLedgerEntry {
  return {
    schemaVersion: 1,
    cycleId: 'cycle-resume',
    status,
    completedAt: new Date().toISOString(),
    totalUsd,
    itemActuals: [
      {
        itemId: 'child-1',
        status,
        actualUsd,
        estimatedComplexity: 'medium',
      },
    ],
  };
}

describe('appendCycleLedgerEntry', () => {
  it('upserts by cycleId so resumed final actuals replace failed rows', () => {
    appendCycleLedgerEntry(root, entry('failed', 1.25, 1.25));
    appendCycleLedgerEntry(root, entry('completed', 4.5, 4.5));

    const rows = readCycleLedgerEntries(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('completed');
    expect(rows[0]!.totalUsd).toBe(4.5);
    expect(rows[0]!.itemActuals).toEqual([
      {
        itemId: 'child-1',
        status: 'completed',
        actualUsd: 4.5,
        estimatedComplexity: 'medium',
      },
    ]);

    const ledgerPath = join(root, '.agentforge', 'memory', 'cycle-ledger.jsonl');
    const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);

    expect(readLedgerCostPriorActuals(root)).toEqual([
      {
        itemId: 'child-1',
        actualUsd: 4.5,
        estimatedComplexity: 'medium',
      },
    ]);
  });

  it('collapses legacy duplicate cycle rows when writing resumed final actuals', () => {
    const ledgerPath = join(root, '.agentforge', 'memory', 'cycle-ledger.jsonl');
    mkdirSync(join(root, '.agentforge', 'memory'), { recursive: true });
    writeFileSync(
      ledgerPath,
      [
        JSON.stringify(entry('failed', 1.25, 1.25)),
        JSON.stringify({
          ...entry('completed', 2.5, 2.5),
          cycleId: 'other-cycle',
        }),
        JSON.stringify(entry('failed', 2.75, 2.75)),
        '',
      ].join('\n'),
      'utf8',
    );

    appendCycleLedgerEntry(root, entry('completed', 4.5, 4.5));

    const rows = readCycleLedgerEntries(root);
    expect(rows.map((row) => row.cycleId)).toEqual(['cycle-resume', 'other-cycle']);
    expect(rows.filter((row) => row.cycleId === 'cycle-resume')).toHaveLength(1);
    expect(rows[0]!.status).toBe('completed');
    expect(rows[0]!.totalUsd).toBe(4.5);

    expect(readLedgerCostPriorActuals(root)).toEqual([
      {
        itemId: 'child-1',
        actualUsd: 4.5,
        estimatedComplexity: 'medium',
      },
      {
        itemId: 'child-1',
        actualUsd: 2.5,
        estimatedComplexity: 'medium',
      },
    ]);
  });
});
