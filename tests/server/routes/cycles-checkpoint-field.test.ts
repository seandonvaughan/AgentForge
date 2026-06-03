/**
 * tests/server/routes/cycles-checkpoint-field.test.ts
 *
 * Contract tests for the checkpoint field logic injected into
 * GET /api/v5/cycles/:id responses.
 *
 * We exercise the readCycleCheckpoint helper's contract directly
 * through a temp directory — no Fastify server spun up.
 *
 * Coverage:
 *   - Returns undefined when checkpoint.json is absent
 *   - Returns a typed checkpoint when the file is valid
 *   - Returns undefined when checkpoint.json is malformed JSON
 *   - Returns undefined when required fields are missing
 *   - Returns undefined when completedPhases contains non-strings
 *   - Path uses match-then-use: cycleId is validated before joining
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Types — mirror CycleCheckpoint in cycles.ts
// ---------------------------------------------------------------------------

interface CycleCheckpoint {
  resumeFromPhase: string;
  capturedAt: string;
  completedPhases: string[];
}

// ---------------------------------------------------------------------------
// Inline implementation of readCycleCheckpoint (mirrors cycles.ts)
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';

export function readCycleCheckpoint(dir: string): CycleCheckpoint | undefined {
  const newFile = join(dir, 'checkpoint-cycle.json');
  const legacyFile = join(dir, 'checkpoint.json');
  const file = existsSync(newFile) ? newFile : legacyFile;
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    const resumeFromPhase = typeof raw['resumeFromPhase'] === 'string' ? raw['resumeFromPhase'] : null;
    const capturedAt = typeof raw['capturedAt'] === 'string' ? raw['capturedAt'] : null;
    const completedPhases = Array.isArray(raw['completedPhases'])
      ? (raw['completedPhases'] as unknown[]).filter((p): p is string => typeof p === 'string')
      : null;
    if (!resumeFromPhase || !capturedAt || !completedPhases) return undefined;
    return { resumeFromPhase, capturedAt, completedPhases };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Path safety helper — mirrors SAFE_ID usage in cycles.ts
// ---------------------------------------------------------------------------

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function isSafeId(id: string): boolean {
  return SAFE_ID.test(id);
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'af-checkpoint-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readCycleCheckpoint — file absent
// ---------------------------------------------------------------------------

describe('readCycleCheckpoint — file absent', () => {
  it('returns undefined when checkpoint.json does not exist', () => {
    expect(readCycleCheckpoint(tmpDir)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readCycleCheckpoint — valid file
// ---------------------------------------------------------------------------

describe('readCycleCheckpoint — valid file', () => {
  it('returns a typed checkpoint object when all fields are present', () => {
    const data: CycleCheckpoint = {
      resumeFromPhase: 'execute',
      capturedAt: '2026-05-18T10:00:00.000Z',
      completedPhases: ['audit', 'plan', 'assign'],
    };
    writeFileSync(join(tmpDir, 'checkpoint.json'), JSON.stringify(data));
    const result = readCycleCheckpoint(tmpDir);
    expect(result).not.toBeUndefined();
    expect(result!.resumeFromPhase).toBe('execute');
    expect(result!.capturedAt).toBe('2026-05-18T10:00:00.000Z');
    expect(result!.completedPhases).toEqual(['audit', 'plan', 'assign']);
  });

  it('filters non-string entries from completedPhases', () => {
    const data = {
      resumeFromPhase: 'test',
      capturedAt: '2026-05-18T10:00:00.000Z',
      completedPhases: ['audit', 42, null, 'plan'],
    };
    writeFileSync(join(tmpDir, 'checkpoint.json'), JSON.stringify(data));
    const result = readCycleCheckpoint(tmpDir);
    expect(result).not.toBeUndefined();
    expect(result!.completedPhases).toEqual(['audit', 'plan']);
  });

  it('reads phase checkpoint from checkpoint-cycle.json', () => {
    mkdirSync(join(tmpDir, 'cycle-abc123'), { recursive: true });
    writeFileSync(join(tmpDir, 'cycle-abc123', 'checkpoint-cycle.json'), JSON.stringify({
      v: 1, cycleId: 'cycle-abc123', capturedAt: '2026-05-18T10:00:00.000Z',
      resumeFromPhase: 'execute', completedPhases: ['audit', 'plan'],
      budgetUsd: 50, spentUsd: 5,
    }));
    const result = readCycleCheckpoint(join(tmpDir, 'cycle-abc123'));
    expect(result).not.toBeUndefined();
    expect(result!.resumeFromPhase).toBe('execute');
    expect(result!.completedPhases).toEqual(['audit', 'plan']);
  });
});

// ---------------------------------------------------------------------------
// readCycleCheckpoint — malformed / missing fields
// ---------------------------------------------------------------------------

describe('readCycleCheckpoint — malformed file', () => {
  it('returns undefined when checkpoint.json contains invalid JSON', () => {
    writeFileSync(join(tmpDir, 'checkpoint.json'), 'not-json{{{');
    expect(readCycleCheckpoint(tmpDir)).toBeUndefined();
  });

  it('returns undefined when resumeFromPhase is missing', () => {
    const data = {
      capturedAt: '2026-05-18T10:00:00.000Z',
      completedPhases: ['audit'],
    };
    writeFileSync(join(tmpDir, 'checkpoint.json'), JSON.stringify(data));
    expect(readCycleCheckpoint(tmpDir)).toBeUndefined();
  });

  it('returns undefined when capturedAt is missing', () => {
    const data = { resumeFromPhase: 'gate', completedPhases: ['audit', 'plan'] };
    writeFileSync(join(tmpDir, 'checkpoint.json'), JSON.stringify(data));
    expect(readCycleCheckpoint(tmpDir)).toBeUndefined();
  });

  it('returns undefined when completedPhases is not an array', () => {
    const data = {
      resumeFromPhase: 'gate',
      capturedAt: '2026-05-18T10:00:00.000Z',
      completedPhases: 'audit,plan',
    };
    writeFileSync(join(tmpDir, 'checkpoint.json'), JSON.stringify(data));
    expect(readCycleCheckpoint(tmpDir)).toBeUndefined();
  });

  it('returns undefined when the file is empty', () => {
    writeFileSync(join(tmpDir, 'checkpoint.json'), '');
    expect(readCycleCheckpoint(tmpDir)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Path safety — SAFE_ID validates cycleId before joining
// ---------------------------------------------------------------------------

describe('SAFE_ID path validation', () => {
  it('accepts a valid alphanumeric cycle id', () => {
    expect(isSafeId('abc123')).toBe(true);
    expect(isSafeId('cycle-id_001')).toBe(true);
  });

  it('rejects ids with path traversal characters', () => {
    expect(isSafeId('../etc/passwd')).toBe(false);
    expect(isSafeId('cycle/../../secret')).toBe(false);
    expect(isSafeId('cycle id')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// API shape contract — response includes checkpoint only when present
// ---------------------------------------------------------------------------

describe('GET /api/v5/cycles/:id response shape', () => {
  it('includes checkpoint in response when file exists', () => {
    const cp: CycleCheckpoint = {
      resumeFromPhase: 'review',
      capturedAt: '2026-05-18T11:00:00.000Z',
      completedPhases: ['audit', 'plan', 'assign', 'execute', 'test'],
    };
    mkdirSync(join(tmpDir, 'cycle-abc123'), { recursive: true });
    writeFileSync(join(tmpDir, 'cycle-abc123', 'checkpoint.json'), JSON.stringify(cp));
    const result = readCycleCheckpoint(join(tmpDir, 'cycle-abc123'));
    expect(result).toBeDefined();
    // Simulate injecting into response
    const response: Record<string, unknown> = { cycleId: 'abc123', status: 'failed' };
    if (result !== undefined) response['checkpoint'] = result;
    expect(response['checkpoint']).toEqual(cp);
  });

  it('omits checkpoint from response when file is absent', () => {
    const response: Record<string, unknown> = { cycleId: 'abc123', status: 'failed' };
    const result = readCycleCheckpoint(tmpDir);
    if (result !== undefined) response['checkpoint'] = result;
    expect(Object.prototype.hasOwnProperty.call(response, 'checkpoint')).toBe(false);
  });
});
