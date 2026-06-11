import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export interface CycleLedgerItemActual {
  itemId: string;
  status: string;
  actualUsd: number;
  estimatedComplexity?: 'low' | 'medium' | 'high';
}

export interface CycleLedgerEntry {
  schemaVersion: 1;
  cycleId: string;
  status: string;
  completedAt: string;
  totalUsd: number;
  itemActuals: CycleLedgerItemActual[];
}

export interface CostPriorActual {
  itemId: string;
  actualUsd: number;
  estimatedComplexity: 'low' | 'medium' | 'high';
}

function ledgerPath(projectRoot: string): string {
  return join(projectRoot, '.agentforge', 'memory', 'cycle-ledger.jsonl');
}

function parseLedgerEntries(raw: string): CycleLedgerEntry[] {
  const entries: CycleLedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<CycleLedgerEntry>;
      if (parsed.schemaVersion === 1 && typeof parsed.cycleId === 'string') {
        entries.push(parsed as CycleLedgerEntry);
      }
    } catch {
      // Ignore corrupt legacy rows; ledger writes are best-effort.
    }
  }
  return entries;
}

export function readCycleLedgerEntries(projectRoot: string): CycleLedgerEntry[] {
  try {
    return parseLedgerEntries(readFileSync(ledgerPath(projectRoot), 'utf8'));
  } catch {
    return [];
  }
}

export function appendCycleLedgerEntry(
  projectRoot: string,
  entry: CycleLedgerEntry,
): void {
  const path = ledgerPath(projectRoot);
  try {
    const entries = readCycleLedgerEntries(projectRoot);
    const existingIndex = entries.findIndex((row) => row.cycleId === entry.cycleId);
    if (existingIndex === -1) {
      entries.push(entry);
    } else {
      entries[existingIndex] = entry;
    }

    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(
      tmp,
      entries.map((row) => JSON.stringify(row)).join('\n') + '\n',
      'utf8',
    );
    renameSync(tmp, path);
  } catch {
    // non-fatal
  }
}

export function readLedgerCostPriorActuals(projectRoot: string): CostPriorActual[] {
  const actuals: CostPriorActual[] = [];
  for (const entry of readCycleLedgerEntries(projectRoot)) {
    for (const item of entry.itemActuals) {
      if (
        item.status !== 'completed' ||
        item.actualUsd <= 0 ||
        (item.estimatedComplexity !== 'low' &&
          item.estimatedComplexity !== 'medium' &&
          item.estimatedComplexity !== 'high')
      ) {
        continue;
      }
      actuals.push({
        itemId: item.itemId,
        actualUsd: item.actualUsd,
        estimatedComplexity: item.estimatedComplexity,
      });
    }
  }
  return actuals;
}
