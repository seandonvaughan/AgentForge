import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CycleCheckpointSchema,
  type CycleCheckpoint,
} from './cycle-artifacts/cycle-checkpoint.js';
import type {
  ExecuteCheckpoint,
  ExecuteCheckpointItemRecord,
  ExecuteCheckpointItemWrite,
} from './types.js';

type JsonObject = Record<string, unknown>;

const CHECKPOINT_FILENAME = 'checkpoint-cycle.json';
const EXECUTE_CHECKPOINT_FILENAME = 'checkpoint-execute.json';
const LEGACY_CHECKPOINT_FILENAME = 'checkpoint.json';
const UNKNOWN_AGENT_ID = 'unknown';

function isSafeCycleId(raw: string): boolean {
  if (raw.length < 8 || raw.length > 64) return false;
  for (const char of raw) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    if (!isDigit && !isUpper && !isLower && char !== '-') return false;
  }
  return true;
}

function pathSegment(cycleDir: string): { parentDir: string; cycleId: string } {
  let end = cycleDir.length;
  while (end > 0) {
    const char = cycleDir[end - 1];
    if (char !== '/' && char !== '\\') break;
    end -= 1;
  }

  let start = end;
  while (start > 0) {
    const char = cycleDir[start - 1];
    if (char === '/' || char === '\\') break;
    start -= 1;
  }

  return {
    parentDir: cycleDir.slice(0, start),
    cycleId: cycleDir.slice(start, end),
  };
}

export function resolveCycleCheckpointPath(cycleDir: string): string {
  const { parentDir, cycleId } = pathSegment(cycleDir);
  if (!isSafeCycleId(cycleId)) {
    throw new Error('[checkpoint] invalid cycleId segment');
  }
  return join(parentDir, cycleId, CHECKPOINT_FILENAME);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readExistingCheckpoint(finalPath: string): JsonObject | null {
  let raw: string;
  try {
    raw = readFileSync(finalPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[checkpoint] refusing to overwrite corrupted checkpoint: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!isJsonObject(parsed)) {
    throw new Error('[checkpoint] refusing to overwrite non-object checkpoint');
  }

  const result = CycleCheckpointSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('[checkpoint] refusing to overwrite invalid checkpoint schema');
  }

  return parsed;
}

function mergeCheckpoint(existing: JsonObject | null, next: CycleCheckpoint): JsonObject {
  const parsed = CycleCheckpointSchema.parse(next);
  const merged: JsonObject = {
    ...(existing ?? {}),
    ...parsed,
  };

  const existingProgress = existing?.executeProgress;
  if (isJsonObject(existingProgress) && parsed.executeProgress !== undefined) {
    const existingAgentOutputs = existingProgress.agentOutputs;
    merged.executeProgress = {
      ...existingProgress,
      ...parsed.executeProgress,
      ...(isJsonObject(existingAgentOutputs)
        ? { agentOutputs: { ...existingAgentOutputs, ...parsed.executeProgress.agentOutputs } }
        : {}),
    };
  }

  return merged;
}

function writeJsonAtomically(finalPath: string, payload: unknown): void {
  const tmpPath = `${finalPath}.tmp`;
  mkdirSync(dirname(finalPath), { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

export function readCycleCheckpoint(cycleDir: string): CycleCheckpoint | null {
  const finalPath = resolveCycleCheckpointPath(cycleDir);
  const existing = readExistingCheckpoint(finalPath);
  return existing === null ? null : CycleCheckpointSchema.parse(existing);
}

export function writeMergedCycleCheckpoint(cycleDir: string, checkpoint: CycleCheckpoint): void {
  const finalPath = resolveCycleCheckpointPath(cycleDir);
  const existing = readExistingCheckpoint(finalPath);
  const merged = mergeCheckpoint(existing, checkpoint);
  writeJsonAtomically(finalPath, merged);
}

export function updateCycleCheckpoint(
  cycleDir: string,
  update: (checkpoint: CycleCheckpoint | null) => CycleCheckpoint,
): CycleCheckpoint {
  const finalPath = resolveCycleCheckpointPath(cycleDir);
  const existing = readExistingCheckpoint(finalPath);
  const current = existing === null ? null : CycleCheckpointSchema.parse(existing);
  const next = CycleCheckpointSchema.parse(update(current));
  const merged = mergeCheckpoint(existing, next);
  writeJsonAtomically(finalPath, merged);
  return CycleCheckpointSchema.parse(merged);
}

export function resolveExecuteCheckpointPath(projectRoot: string, cycleId: string): string {
  if (!isSafeCycleId(cycleId)) {
    throw new Error('[checkpoint] invalid cycleId segment');
  }
  return join(projectRoot, '.agentforge', 'cycles', cycleId, EXECUTE_CHECKPOINT_FILENAME);
}

function resolveLegacyExecuteCheckpointPath(projectRoot: string, cycleId: string): string {
  if (!isSafeCycleId(cycleId)) {
    throw new Error('[checkpoint] invalid cycleId segment');
  }
  return join(projectRoot, '.agentforge', 'cycles', cycleId, LEGACY_CHECKPOINT_FILENAME);
}

function readJsonFile(path: string): unknown | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }

  return JSON.parse(raw);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function itemStatus(value: unknown): ExecuteCheckpointItemRecord['status'] | null {
  return value === 'completed' || value === 'failed' || value === 'skipped' ? value : null;
}

function isFiniteCost(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseItemRecord(itemId: string, value: unknown): ExecuteCheckpointItemRecord | null {
  if (!isJsonObject(value)) return null;
  const status = itemStatus(value.status);
  if (status === null) return null;
  if (!isFiniteCost(value.costUsd)) return null;
  if (typeof value.agentId !== 'string') return null;
  if (typeof value.completedAt !== 'string') return null;
  return {
    itemId: typeof value.itemId === 'string' ? value.itemId : itemId,
    status,
    costUsd: value.costUsd,
    agentId: value.agentId,
    completedAt: value.completedAt,
  };
}

function legacyCompletedItemRecord(
  itemId: string,
  completedAt: string,
): ExecuteCheckpointItemRecord {
  return {
    itemId,
    status: 'completed',
    costUsd: 0,
    agentId: UNKNOWN_AGENT_ID,
    completedAt,
  };
}

function parseItems(
  value: unknown,
  completedItemIds: string[],
  completedAt: string,
): Record<string, ExecuteCheckpointItemRecord> {
  const items: Record<string, ExecuteCheckpointItemRecord> = {};
  if (isJsonObject(value)) {
    for (const [itemId, rawItem] of Object.entries(value)) {
      const parsed = parseItemRecord(itemId, rawItem);
      if (parsed !== null) {
        items[itemId] = parsed;
      }
    }
  }

  for (const itemId of completedItemIds) {
    if (items[itemId] === undefined) {
      items[itemId] = legacyCompletedItemRecord(itemId, completedAt);
    }
  }

  return items;
}

function parseExecuteCheckpoint(value: unknown, cycleId: string): ExecuteCheckpoint | null {
  if (!isJsonObject(value)) return null;
  if (value.cycleId !== cycleId || value.phase !== 'execute') return null;
  if (!isStringArray(value.completedItemIds)) return null;
  if (typeof value.currentItemId !== 'string' && value.currentItemId !== null) return null;
  if (typeof value.totalItems !== 'number' || !Number.isInteger(value.totalItems)) return null;
  if (typeof value.lastUpdatedAt !== 'string') return null;
  if (value.schemaVersion !== 2 && value.schemaVersion !== 3) return null;

  const items = parseItems(value.items, value.completedItemIds, value.lastUpdatedAt);
  return {
    cycleId,
    phase: 'execute',
    completedItemIds: value.completedItemIds,
    currentItemId: value.currentItemId,
    totalItems: value.totalItems,
    lastUpdatedAt: value.lastUpdatedAt,
    schemaVersion: 3,
    items,
  };
}

function initialExecuteCheckpoint(cycleId: string, totalItems: number, now: string): ExecuteCheckpoint {
  return {
    cycleId,
    phase: 'execute',
    completedItemIds: [],
    currentItemId: null,
    totalItems,
    lastUpdatedAt: now,
    schemaVersion: 3,
    items: {},
  };
}

export function readExecuteCheckpoint(projectRoot: string, cycleId: string): ExecuteCheckpoint | null {
  for (const resolver of [resolveExecuteCheckpointPath, resolveLegacyExecuteCheckpointPath]) {
    let checkpointPath: string;
    try {
      checkpointPath = resolver(projectRoot, cycleId);
    } catch {
      return null;
    }

    try {
      const parsed = readJsonFile(checkpointPath);
      if (parsed === null) continue;
      const checkpoint = parseExecuteCheckpoint(parsed, cycleId);
      if (checkpoint !== null) return checkpoint;
    } catch {
      continue;
    }
  }

  return null;
}

export function getCompletedExecuteItems(
  projectRoot: string,
  cycleId: string,
): Record<string, ExecuteCheckpointItemRecord> {
  const checkpoint = readExecuteCheckpoint(projectRoot, cycleId);
  if (checkpoint === null) return {};

  const completedItems: Record<string, ExecuteCheckpointItemRecord> = {};
  for (const itemId of checkpoint.completedItemIds) {
    const item = checkpoint.items[itemId];
    if (item !== undefined) {
      completedItems[itemId] = item;
    }
  }
  return completedItems;
}

export function writeExecuteCheckpointItem(
  projectRoot: string,
  input: ExecuteCheckpointItemWrite,
): ExecuteCheckpoint {
  const now = input.completedAt ?? new Date().toISOString();
  const existing = readExecuteCheckpoint(projectRoot, input.cycleId);
  const checkpoint = existing ?? initialExecuteCheckpoint(
    input.cycleId,
    input.totalItems ?? 0,
    now,
  );
  const completedItemIds =
    input.status === 'completed' && !checkpoint.completedItemIds.includes(input.itemId)
      ? [...checkpoint.completedItemIds, input.itemId]
      : checkpoint.completedItemIds;
  const record: ExecuteCheckpointItemRecord = {
    itemId: input.itemId,
    status: input.status,
    costUsd: input.costUsd,
    agentId: input.agentId,
    completedAt: now,
  };
  const next: ExecuteCheckpoint = {
    ...checkpoint,
    completedItemIds,
    totalItems: input.totalItems ?? checkpoint.totalItems,
    currentItemId: null,
    lastUpdatedAt: now,
    schemaVersion: 3,
    items: {
      ...checkpoint.items,
      [input.itemId]: record,
    },
  };

  writeJsonAtomically(resolveExecuteCheckpointPath(projectRoot, input.cycleId), next);
  return next;
}
