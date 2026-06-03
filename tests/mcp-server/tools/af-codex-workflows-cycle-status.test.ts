import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { afCycleStatus } from '../../../packages/mcp-server/src/tools/af-codex-workflows.js';

const PENDING_CYCLE_ID = 'aa112233-4455-6677-8899-aabbccddeeff';
const DECIDED_CYCLE_ID = 'bb112233-4455-6677-8899-aabbccddeeff';
const PARTIAL_CYCLE_ID = 'cc112233-4455-6677-8899-aabbccddeeff';
const MISSING_CYCLE_ID = 'dd112233-4455-6677-8899-aabbccddeeff';

interface CycleStatusListData {
  cycles: Array<{
    cycleId: string;
  }>;
}

interface CycleStatusSingleData {
  cycle: {
    cycleId: string;
    stage: string;
    hasApprovalPending: boolean;
    approvalDecision: string | null;
  };
}

let projectRoot = '';

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycle-status-'));
  const cyclesDir = join(projectRoot, '.agentforge', 'cycles');
  mkdirSync(cyclesDir, { recursive: true });

  writeCycleJson(PENDING_CYCLE_ID, {
    cycleId: PENDING_CYCLE_ID,
    stage: 'gate',
    startedAt: '2026-01-02T12:00:00.000Z',
    sprintVersion: 'v5.10',
    cost: { totalUsd: 12.5, budgetUsd: 200 },
    tests: { passed: 11, total: 12 },
  });
  writeJson(join(cyclesDir, PENDING_CYCLE_ID, 'approval-pending.json'), {
    requestedAt: '2026-01-02T12:30:00.000Z',
    reason: 'merge gate requires approval',
  });

  writeCycleJson(DECIDED_CYCLE_ID, {
    cycleId: DECIDED_CYCLE_ID,
    stage: 'pr',
    startedAt: '2026-01-03T12:00:00.000Z',
    sprintVersion: 'v5.10',
    cost: { totalUsd: 20, budgetUsd: 200 },
    tests: { passed: 12, total: 12 },
  });
  writeJson(join(cyclesDir, DECIDED_CYCLE_ID, 'approval-decision.json'), {
    decision: 'approved',
    decidedAt: '2026-01-03T13:00:00.000Z',
  });

  const partialCycleDir = join(cyclesDir, PARTIAL_CYCLE_ID);
  mkdirSync(partialCycleDir, { recursive: true });
  writeFileSync(
    join(partialCycleDir, 'events.jsonl'),
    '{"type":"cycle.started","at":"2026-01-01T12:00:00.000Z"}\n',
    'utf8',
  );
  const partialTime = new Date('2026-01-01T12:00:00.000Z');
  utimesSync(partialCycleDir, partialTime, partialTime);
});

afterEach(() => {
  if (projectRoot.length > 0) {
    rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = '';
  }
});

describe('afCycleStatus', () => {
  it('lists cycle summaries newest-first and reads single-cycle approval state', () => {
    const result = afCycleStatus({ projectRoot, limit: 2 }, projectRoot);
    const listData = result.data as CycleStatusListData | null;

    expect(result.ok).toBe(true);
    expect(listData?.cycles[0]?.cycleId).toBe('bb112233-4455-6677-8899-aabbccddeeff');
    expect(listData?.cycles).toHaveLength(2);

    const singleResult = afCycleStatus({ projectRoot, cycleId: PENDING_CYCLE_ID }, projectRoot);
    const singleData = singleResult.data as CycleStatusSingleData | null;

    expect(singleResult.ok).toBe(true);
    expect(singleData?.cycle?.cycleId).toBe(PENDING_CYCLE_ID);

    const pendingResult = afCycleStatus({ projectRoot, cycleId: PENDING_CYCLE_ID }, projectRoot);
    const pendingData = pendingResult.data as CycleStatusSingleData | null;

    expect(pendingResult.ok).toBe(true);
    expect(pendingData?.cycle?.hasApprovalPending).toBe(true);

    const decidedResult = afCycleStatus({ projectRoot, cycleId: DECIDED_CYCLE_ID }, projectRoot);
    const decidedData = decidedResult.data as CycleStatusSingleData | null;

    expect(decidedResult.ok).toBe(true);
    expect(decidedData?.cycle?.approvalDecision).toBe('approved');

    const partialResult = afCycleStatus({ projectRoot, cycleId: PARTIAL_CYCLE_ID }, projectRoot);
    const partialData = partialResult.data as CycleStatusSingleData | null;

    expect(partialResult.ok).toBe(true);
    expect(partialData?.cycle?.stage).toBe('plan');

    const invalidResult = afCycleStatus({ projectRoot, cycleId: '../bad-cycle' }, projectRoot);

    expect(invalidResult.error?.code).toBe('INVALID_CYCLE_ID');

    const missingResult = afCycleStatus({ projectRoot, cycleId: MISSING_CYCLE_ID }, projectRoot);

    expect(missingResult.error?.code).toBe('CYCLE_NOT_FOUND');
  });
});

function writeCycleJson(cycleId: string, value: Record<string, unknown>): void {
  const cycleDir = join(projectRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeJson(join(cycleDir, 'cycle.json'), value);
  writeFileSync(
    join(cycleDir, 'events.jsonl'),
    '{"type":"cycle.started"}\n{"type":"cycle.completed"}\n',
    'utf8',
  );
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
