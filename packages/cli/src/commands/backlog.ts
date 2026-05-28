import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';

interface BacklogCompleteOptions {
  projectRoot: string;
  cycle?: string;
  pr?: string;
  reason?: string;
}

interface BacklogStatusOptions {
  projectRoot: string;
  json?: boolean;
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

interface BacklogFileItem {
  id: string;
  title: string;
  estimatedComplexity?: 'low' | 'medium' | 'high';
  files?: string[];
  runtimeMode?: 'auto' | 'sdk' | 'claude-code-compat' | 'codex-cli' | 'openai-sdk' | 'anthropic-sdk';
  preferredProvider?: 'claude-code-compat' | 'codex-cli' | 'openai-sdk' | 'anthropic-sdk';
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

  backlog
    .command('status')
    .description('Show deterministic backlog visibility before cycle replay')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--json', 'Print machine-readable JSON')
    .action(async (opts: BacklogStatusOptions) => {
      try {
        await printBacklogStatus(opts);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}

async function markBacklogItemCompleted(itemIdInput: string, opts: BacklogCompleteOptions): Promise<void> {
  const itemId = normalizeBacklogId(itemIdInput);
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
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`Invalid --pr value "${raw}": expected a positive integer like 123`);
  }
  const num = Number(raw);
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

async function printBacklogStatus(opts: BacklogStatusOptions): Promise<void> {
  const projectRoot = resolve(opts.projectRoot);
  const backlogDir = join(projectRoot, '.agentforge', 'backlog');
  const completed = readLedger(join(backlogDir, 'completed.json'));
  const completedIds = new Set(completed.entries.map((entry) => entry.itemId));
  const quarantineIds = readQuarantineIds(join(backlogDir, 'quarantine.json'));
  const backlogItems = readBacklogFileItems(backlogDir);
  const activeItems = backlogItems.filter((item) => !completedIds.has(item.id) && !quarantineIds.has(item.id));
  const unattendedExcluded = activeItems.filter(isUnattendedExcludedBacklogItem);
  const activeScoped = activeItems
    .filter((item) => !isUnattendedExcludedBacklogItem(item))
    .sort((a, b) => {
      const idCompare = a.id.localeCompare(b.id);
      if (idCompare !== 0) return idCompare;
      return a.title.localeCompare(b.title);
    });
  const routedScoped = activeScoped.filter((item) => item.runtimeMode !== undefined || item.preferredProvider !== undefined);
  const defaultScoped = activeScoped.length - routedScoped.length;

  if (opts.json) {
    console.log(JSON.stringify({
      projectRoot,
      activeBacklogFileItems: activeItems.length,
      completedLedgerEntries: completed.entries.length,
      quarantinedIds: quarantineIds.size,
      unattendedExcludedBacklogItems: unattendedExcluded.length,
      runtimeRoutingHints: {
        scopedItems: activeScoped.length,
        routedItems: routedScoped.length,
        defaultItems: defaultScoped,
      },
      activeScopedItems: activeScoped.map((item) => ({
        id: item.id,
        title: item.title,
        estimatedComplexity: item.estimatedComplexity,
        runtimeMode: item.runtimeMode ?? null,
        preferredProvider: item.preferredProvider ?? null,
        scopeFiles: item.files ?? [],
      })),
    }, null, 2));
    return;
  }

  console.log('[backlog] status');
  console.log(`  projectRoot: ${projectRoot}`);
  console.log(`  activeBacklogFileItems: ${activeItems.length}`);
  console.log(`  completedLedgerEntries: ${completed.entries.length}`);
  console.log(`  quarantinedIds: ${quarantineIds.size}`);
  console.log(`  unattendedExcludedBacklogItems: ${unattendedExcluded.length}`);
  console.log(`  runtimeRoutingHints: scoped=${activeScoped.length} routed=${routedScoped.length} default=${defaultScoped}`);
  console.log('  activeScopedItems:');
  if (activeScoped.length === 0) {
    console.log('    (none)');
    return;
  }

  for (const item of activeScoped) {
    const hints = [
      item.estimatedComplexity ? `complexity=${item.estimatedComplexity}` : null,
      `scope=${(item.files ?? []).join(',')}`,
      item.runtimeMode ? `runtime=${item.runtimeMode}` : null,
      item.preferredProvider ? `provider=${item.preferredProvider}` : null,
    ].filter((hint): hint is string => hint !== null);
    const suffix = hints.length > 0 ? ` [${hints.join(', ')}]` : '';
    console.log(`    - ${item.id}: ${item.title}${suffix}`);
  }
}

function readBacklogFileItems(backlogDir: string): BacklogFileItem[] {
  let files: string[];
  try {
    files = readdirSync(backlogDir).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }

  const items: BacklogFileItem[] = [];
  for (const file of files.sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(backlogDir, file), 'utf8')) as unknown;
    } catch {
      continue;
    }

    const rawItems = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { items?: unknown } | null)?.items)
        ? (parsed as { items: unknown[] }).items
        : [];

    for (const raw of rawItems) {
      const item = normalizeBacklogFileItem(raw, file);
      if (item) items.push(item);
    }
  }

  return items;
}

function normalizeBacklogFileItem(raw: unknown, fileName: string): BacklogFileItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const title = typeof obj['title'] === 'string' ? obj['title'].trim() : '';
  if (!title) return null;

  const idRaw = typeof obj['id'] === 'string' && obj['id'].trim()
    ? obj['id'].trim()
    : `${fileName}-${title}`;
  const id = normalizeBacklogId(idRaw);
  if (!id) return null;
  const item: BacklogFileItem = {
    id,
    title,
  };

  const complexity = typeof obj['estimatedComplexity'] === 'string'
    ? obj['estimatedComplexity'].toLowerCase()
    : undefined;
  if (complexity === 'low' || complexity === 'medium' || complexity === 'high') {
    item.estimatedComplexity = complexity;
  }

  const files = Array.isArray(obj['files'])
    ? obj['files'].filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
    : [];
  if (files.length > 0) {
    item.files = files;
  }

  const runtimeMode = typeof obj['runtimeMode'] === 'string'
    ? obj['runtimeMode']
    : undefined;
  if (
    runtimeMode === 'auto'
    || runtimeMode === 'sdk'
    || runtimeMode === 'claude-code-compat'
    || runtimeMode === 'codex-cli'
    || runtimeMode === 'openai-sdk'
    || runtimeMode === 'anthropic-sdk'
  ) {
    item.runtimeMode = runtimeMode;
  }

  const preferredProvider = typeof obj['preferredProvider'] === 'string'
    ? obj['preferredProvider']
    : undefined;
  if (
    preferredProvider === 'claude-code-compat'
    || preferredProvider === 'codex-cli'
    || preferredProvider === 'openai-sdk'
    || preferredProvider === 'anthropic-sdk'
  ) {
    item.preferredProvider = preferredProvider;
  }

  return item;
}

function readQuarantineIds(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const ids = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { ids?: unknown } | null)?.ids)
        ? (parsed as { ids: unknown[] }).ids
        : [];
    return new Set(
      ids
        .map((x) => (typeof x === 'string' ? normalizeBacklogId(x) : null))
        .filter((id): id is string => id !== null),
    );
  } catch {
    return new Set();
  }
}

function isUnattendedExcludedBacklogItem(item: BacklogFileItem): boolean {
  if (item.estimatedComplexity === 'high') return true;
  if (item.files === undefined || item.files.length === 0) return true;
  return false;
}

function normalizeEntry(value: unknown): CompletedBacklogEntry | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const itemIdRaw = typeof obj['itemId'] === 'string'
    ? obj['itemId'].trim()
    : typeof obj['id'] === 'string'
      ? obj['id'].trim()
      : '';
  const itemId = normalizeBacklogId(itemIdRaw);
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

function normalizeBacklogId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let normalized = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  while (normalized.startsWith('-')) normalized = normalized.slice(1);
  while (normalized.endsWith('-')) normalized = normalized.slice(0, -1);
  if (!normalized) return null;

  if (normalized === 'backlog') return null;
  if (normalized.startsWith('backlog-')) return normalized;
  return `backlog-${normalized}`;
}
