import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CycleCheckpointSchema,
  type CycleCheckpoint,
} from './cycle-artifacts/cycle-checkpoint.js';

type JsonObject = Record<string, unknown>;

const CHECKPOINT_FILENAME = 'checkpoint-cycle.json';

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

function writeJsonAtomically(finalPath: string, payload: JsonObject): void {
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
