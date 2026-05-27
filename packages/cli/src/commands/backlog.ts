import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';

interface BacklogCompleteOptions {
  projectRoot: string;
  cycle?: string;
  pr?: string;
  reason?: string;
}

interface CompletedBacklogEntry {
  itemId: string;
  completedAt: string;
  updatedAt: string;
  cycleId?: string;
  prNumber?: number;
  reason?: string;
}

interface CompletedBacklogLedger {
  version: 1;
  entries: CompletedBacklogEntry[];
}

export function registerBacklogCommand(program: Command): void {
  const backlog = program
    .command('backlog')
    .description('Manage autonomous backlog ledgers');

  backlog
    .command('complete <itemId>')
    .description('Mark a backlog item as completed to prevent replay')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--cycle <cycleId>', 'Cycle id that completed this backlog item')
    .option('--pr <number>', 'PR number that merged this backlog item')
    .option('--reason <text>', 'Operator note explaining why this item is complete')
    .action(async (itemId: string, opts: BacklogCompleteOptions) => {
      try {
        await markBacklogItemCompleted(itemId, opts);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}

async function markBacklogItemCompleted(itemIdInput: string, opts: BacklogCompleteOptions): Promise<void> {
  const itemId = itemIdInput.trim();
  if (!itemId) {
    throw new Error('itemId must not be empty');
  }

  const projectRoot = resolve(opts.projectRoot);
  const backlogDir = join(projectRoot, '.agentforge', 'backlog');
  const ledgerPath = join(backlogDir, 'completed.json');
  const now = new Date().toISOString();

  const prNumber = parsePrNumber(opts.pr);
  const cycleId = typeof opts.cycle === 'string' && opts.cycle.trim().length > 0
    ? opts.cycle.trim()
    : undefined;
  const reason = typeof opts.reason === 'string' && opts.reason.trim().length > 0
    ? opts.reason.trim()
    : undefined;

  const existing = readLedger(ledgerPath);
  const index = existing.entries.findIndex((entry) => entry.itemId === itemId);
  if (index >= 0) {
    const current = existing.entries[index]!;
    existing.entries[index] = {
      ...current,
      itemId,
      completedAt: current.completedAt || now,
      updatedAt: now,
      ...(cycleId ? { cycleId } : {}),
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(reason ? { reason } : {}),
    };
  } else {
    existing.entries.push({
      itemId,
      completedAt: now,
      updatedAt: now,
      ...(cycleId ? { cycleId } : {}),
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  mkdirSync(backlogDir, { recursive: true });
  writeFileSync(ledgerPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');

  console.log(
    `[backlog] ${index >= 0 ? 'updated' : 'recorded'} completion: ${itemId} (${ledgerPath})`,
  );
}

function parsePrNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const num = Number.parseInt(raw, 10);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`Invalid --pr value: ${raw}`);
  }
  return num;
}

function readLedger(path: string): CompletedBacklogLedger {
  if (!existsSync(path)) return { version: 1, entries: [] };

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const rawEntries = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { entries?: unknown } | null)?.entries)
        ? (parsed as { entries: unknown[] }).entries
        : [];
    const entries = rawEntries
      .map(normalizeEntry)
      .filter((entry): entry is CompletedBacklogEntry => entry !== null);
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

function normalizeEntry(value: unknown): CompletedBacklogEntry | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const itemId = typeof obj['itemId'] === 'string'
    ? obj['itemId'].trim()
    : typeof obj['id'] === 'string'
      ? obj['id'].trim()
      : '';
  if (!itemId) return null;

  const completedAt = typeof obj['completedAt'] === 'string' && obj['completedAt'].trim().length > 0
    ? obj['completedAt']
    : new Date().toISOString();
  const updatedAt = typeof obj['updatedAt'] === 'string' && obj['updatedAt'].trim().length > 0
    ? obj['updatedAt']
    : completedAt;

  const entry: CompletedBacklogEntry = {
    itemId,
    completedAt,
    updatedAt,
  };

  if (typeof obj['cycleId'] === 'string' && obj['cycleId'].trim().length > 0) {
    entry.cycleId = obj['cycleId'].trim();
  }
  if (typeof obj['prNumber'] === 'number' && Number.isFinite(obj['prNumber'])) {
    entry.prNumber = obj['prNumber'];
  }
  if (typeof obj['reason'] === 'string' && obj['reason'].trim().length > 0) {
    entry.reason = obj['reason'].trim();
  }

  return entry;
}
