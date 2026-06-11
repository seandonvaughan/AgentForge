import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  updateCycleCheckpoint,
  writeMergedCycleCheckpoint,
} from '../../../packages/core/src/autonomous/checkpoint.js';
import type { CycleCheckpoint } from '../../../packages/core/src/autonomous/cycle-artifacts/cycle-checkpoint.js';

describe('autonomous cycle checkpoint manager', () => {
  let tmpDir: string;
  const cycleId = 'cycle-checkpoint-0001';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-checkpoint-manager-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function cycleDir(): string {
    return join(tmpDir, '.agentforge', 'cycles', cycleId);
  }

  function checkpointPath(): string {
    return join(cycleDir(), 'checkpoint-cycle.json');
  }

  function checkpoint(overrides: Partial<CycleCheckpoint> = {}): CycleCheckpoint {
    return {
      v: 1,
      cycleId,
      capturedAt: '2026-06-11T00:00:00.000Z',
      resumeFromPhase: 'audit',
      completedPhases: [],
      budgetUsd: 100,
      spentUsd: 0,
      ...overrides,
    };
  }

  it('leaves corrupted checkpoint bytes unchanged instead of overwriting them', () => {
    mkdirSync(cycleDir(), { recursive: true });
    const corruptedBytes = '{ this is not valid json';
    writeFileSync(checkpointPath(), corruptedBytes, 'utf8');

    expect(() => writeMergedCycleCheckpoint(cycleDir(), checkpoint())).toThrow(
      'refusing to overwrite corrupted checkpoint',
    );

    expect(readFileSync(checkpointPath(), 'utf8')).toBe(corruptedBytes);
  });

  it('leaves checkpoint bytes unchanged when resume update logic fails', () => {
    mkdirSync(cycleDir(), { recursive: true });
    const originalBytes = JSON.stringify(
      {
        ...checkpoint({
          resumeFromPhase: 'execute',
          completedPhases: ['audit', 'plan', 'assign'],
          spentUsd: 12.5,
        }),
        operatorNote: 'preserve this exactly on failure',
      },
      null,
      2,
    ) + '\n';
    writeFileSync(checkpointPath(), originalBytes, 'utf8');

    expect(() => updateCycleCheckpoint(cycleDir(), () => {
      throw new Error('resume path failed');
    })).toThrow('resume path failed');

    expect(readFileSync(checkpointPath(), 'utf8')).toBe(originalBytes);
  });

  it('preserves existing checkpoint fields on successful merged writes', () => {
    mkdirSync(cycleDir(), { recursive: true });
    writeFileSync(
      checkpointPath(),
      JSON.stringify(
        {
          ...checkpoint({
            resumeFromPhase: 'execute',
            completedPhases: ['audit', 'plan', 'assign'],
            spentUsd: 7,
            executeProgress: {
              completedItemIds: ['child-1'],
              inFlightItemIds: [],
              costSoFarUsd: 7,
              agentOutputs: { 'child-1': { ok: true } },
            },
          }),
          restoredFromPreviousRun: true,
          executeProgress: {
            completedItemIds: ['child-1'],
            inFlightItemIds: [],
            costSoFarUsd: 7,
            agentOutputs: { 'child-1': { ok: true } },
            retainedDiagnostic: 'keep',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    writeMergedCycleCheckpoint(cycleDir(), checkpoint({
      capturedAt: '2026-06-11T00:01:00.000Z',
      resumeFromPhase: 'gate',
      completedPhases: ['audit', 'plan', 'assign', 'execute', 'test', 'review'],
      spentUsd: 8,
      executeProgress: {
        completedItemIds: ['child-1', 'child-2'],
        inFlightItemIds: [],
        costSoFarUsd: 8,
        agentOutputs: { 'child-2': { ok: true } },
      },
    }));

    const written = JSON.parse(readFileSync(checkpointPath(), 'utf8'));
    expect(written).toMatchObject({
      restoredFromPreviousRun: true,
      resumeFromPhase: 'gate',
      spentUsd: 8,
      executeProgress: {
        completedItemIds: ['child-1', 'child-2'],
        retainedDiagnostic: 'keep',
        agentOutputs: {
          'child-1': { ok: true },
          'child-2': { ok: true },
        },
      },
    });
  });
});
