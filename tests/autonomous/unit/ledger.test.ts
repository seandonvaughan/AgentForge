import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
});
