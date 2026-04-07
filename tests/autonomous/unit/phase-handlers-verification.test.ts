// tests/autonomous/unit/phase-handlers-verification.test.ts
//
// v6.5.2 — Tests for the verification phase handlers (test, review,
// release). All runtime calls are mocked; no real agent dispatches.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runTestPhase,
  parseConfidence,
} from '../../../packages/core/src/autonomous/phase-handlers/test-phase.js';
import {
  runReviewPhase,
  parseVerdict,
} from '../../../packages/core/src/autonomous/phase-handlers/review-phase.js';
import { runReleasePhase } from '../../../packages/core/src/autonomous/phase-handlers/release-phase.js';
import type { PhaseContext } from '../../../packages/core/src/autonomous/phase-scheduler.js';

function makeMockBus() {
  const published: Array<{ topic: string; payload: any }> = [];
  return {
    published,
    bus: {
      publish: (topic: string, payload: any) => {
        published.push({ topic, payload });
      },
      subscribe: (_topic: string, _cb: (event: any) => void) => () => {},
    } as any,
  };
}

function makeCtx(opts: {
  cwd: string;
  sprintVersion: string;
  cycleId?: string;
  runtime: any;
  bus: any;
}): PhaseContext {
  return {
    sprintId: `v${opts.sprintVersion}-test`,
    sprintVersion: opts.sprintVersion,
    projectRoot: opts.cwd,
    adapter: {},
    bus: opts.bus,
    runtime: opts.runtime,
    ...(opts.cycleId ? { cycleId: opts.cycleId } : {}),
  };
}

function writeExecuteJson(cwd: string, cycleId: string, itemResults: unknown[]) {
  const dir = join(cwd, '.agentforge', 'cycles', cycleId, 'phases');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'execute.json'),
    JSON.stringify({ phase: 'execute', itemResults }, null, 2),
  );
}

function writeSprint(cwd: string, version: string) {
  const dir = join(cwd, '.agentforge', 'sprints');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `v${version}.json`),
    JSON.stringify(
      {
        sprints: [
          {
            version,
            sprintId: `v${version}-test`,
            phase: 'planned',
            items: [
              { id: 'i1', title: 'a', assignee: 'coder', status: 'completed' },
              { id: 'i2', title: 'b', assignee: 'coder', status: 'completed' },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
}

describe('verification phase handlers', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-verify-phase-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ----- TEST phase -----

  it('test phase calls backend-qa and writes test.json with confidence', async () => {
    const cycleId = 'cycle-1';
    writeExecuteJson(tmpDir, cycleId, [
      { itemId: 'i1', status: 'completed' },
    ]);
    const runtime = {
      run: vi.fn().mockResolvedValue({
        output: '## Strategy\n- concern A\n- concern B\nConfidence: 4/5',
        costUsd: 0.05,
      }),
    };
    const { bus, published } = makeMockBus();
    const result = await runTestPhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '6.5.2', cycleId, runtime, bus }),
    );

    expect(runtime.run).toHaveBeenCalledTimes(1);
    expect(runtime.run.mock.calls[0][0]).toBe('backend-qa');
    expect(runtime.run.mock.calls[0][2]).toEqual({
      allowedTools: ['Read', 'Bash', 'Glob', 'Grep'],
    });
    expect(result.status).toBe('completed');
    expect(result.costUsd).toBe(0.05);

    const written = JSON.parse(
      readFileSync(join(tmpDir, '.agentforge/cycles/cycle-1/phases/test.json'), 'utf8'),
    );
    expect(written.confidence).toBe(4);
    expect(written.agentId).toBe('backend-qa');
    expect(written.concerns.length).toBeGreaterThanOrEqual(2);

    expect(published.find((p) => p.topic === 'sprint.phase.started')).toBeTruthy();
    expect(published.find((p) => p.topic === 'sprint.phase.completed')).toBeTruthy();
  });

  it('test phase handles missing execute.json gracefully', async () => {
    const runtime = {
      run: vi.fn().mockResolvedValue({ output: 'ok confidence: 3/5', costUsd: 0 }),
    };
    const { bus } = makeMockBus();
    const result = await runTestPhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '6.5.2', cycleId: 'no-exec', runtime, bus }),
    );
    expect(result.status).toBe('completed');
    // The prompt should still have been built — itemResults JSON would be empty array.
    const taskArg = runtime.run.mock.calls[0][1] as string;
    expect(taskArg).toContain('[]');
  });

  it('parseConfidence parses scores from various formats', () => {
    expect(parseConfidence('Confidence: 5/5')).toBe(5);
    expect(parseConfidence('Confidence: 2')).toBe(2);
    expect(parseConfidence('Overall 4/5 verdict')).toBe(4);
    expect(parseConfidence('Confidence score is high: 5')).toBe(5);
  });

  it('parseConfidence falls back to 3 when unparseable', () => {
    expect(parseConfidence('')).toBe(3);
    expect(parseConfidence('no numbers here at all')).toBe(3);
    expect(parseConfidence('confidence: high')).toBe(3);
  });

  // ----- REVIEW phase -----

  it('review phase calls code-reviewer and writes review.json', async () => {
    const cycleId = 'cycle-2';
    const runtime = {
      run: vi.fn().mockResolvedValue({
        output: '## Review\n- issue 1\nVerdict: 4/5',
        costUsd: 0.07,
      }),
    };
    const { bus, published } = makeMockBus();
    const result = await runReviewPhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '6.5.2', cycleId, runtime, bus }),
    );

    expect(runtime.run).toHaveBeenCalledTimes(1);
    expect(runtime.run.mock.calls[0][0]).toBe('code-reviewer');
    expect(result.status).toBe('completed');
    expect(result.costUsd).toBe(0.07);

    const written = JSON.parse(
      readFileSync(join(tmpDir, '.agentforge/cycles/cycle-2/phases/review.json'), 'utf8'),
    );
    expect(written.verdict).toBe(4);
    expect(written.agentId).toBe('code-reviewer');
    expect(published.find((p) => p.topic === 'sprint.phase.started')).toBeTruthy();
    expect(published.find((p) => p.topic === 'sprint.phase.completed')).toBeTruthy();
  });

  it('parseVerdict captures the verdict score from a review', () => {
    expect(parseVerdict('Final verdict: 1/5 — reject')).toBe(1);
    expect(parseVerdict('verdict 5')).toBe(5);
    expect(parseVerdict('My overall verdict: 3')).toBe(3);
    expect(parseVerdict('garbage')).toBe(3);
  });

  // ----- RELEASE phase -----

  it('release phase is a no-op that writes release.json with releasedAt', async () => {
    const cycleId = 'cycle-3';
    writeSprint(tmpDir, '6.5.2');
    const runtime = { run: vi.fn() };
    const { bus } = makeMockBus();
    const result = await runReleasePhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '6.5.2', cycleId, runtime, bus }),
    );

    expect(runtime.run).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(result.costUsd).toBe(0);

    const path = join(tmpDir, '.agentforge/cycles/cycle-3/phases/release.json');
    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(typeof written.releasedAt).toBe('string');
    expect(written.releasedAt).toMatch(/T.*Z$/);
    expect(written.itemCount).toBe(2);
  });

  it('release phase publishes phase.completed without calling runtime.run', async () => {
    writeSprint(tmpDir, '6.5.2');
    const runtime = { run: vi.fn() };
    const { bus, published } = makeMockBus();
    await runReleasePhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '6.5.2', cycleId: 'cycle-4', runtime, bus }),
    );

    expect(runtime.run).not.toHaveBeenCalled();
    expect(published.find((p) => p.topic === 'sprint.phase.started')).toBeTruthy();
    expect(published.find((p) => p.topic === 'sprint.phase.completed')).toBeTruthy();
  });

  it('release phase updates sprint JSON phase field to release', async () => {
    writeSprint(tmpDir, '6.5.2');
    const runtime = { run: vi.fn() };
    const { bus } = makeMockBus();
    await runReleasePhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '6.5.2', cycleId: 'cycle-5', runtime, bus }),
    );
    const sprint = JSON.parse(
      readFileSync(join(tmpDir, '.agentforge/sprints/v6.5.2.json'), 'utf8'),
    );
    expect(sprint.sprints[0].phase).toBe('release');
  });

  it('all three phases publish phase.started and phase.completed events', async () => {
    writeSprint(tmpDir, '6.5.2');
    const runtime = {
      run: vi.fn().mockResolvedValue({ output: 'verdict 3/5', costUsd: 0 }),
    };
    const { bus, published } = makeMockBus();
    await runTestPhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '6.5.2', cycleId: 'c', runtime, bus }),
    );
    await runReviewPhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '6.5.2', cycleId: 'c', runtime, bus }),
    );
    await runReleasePhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '6.5.2', cycleId: 'c', runtime, bus }),
    );
    const started = published.filter((p) => p.topic === 'sprint.phase.started');
    const completed = published.filter((p) => p.topic === 'sprint.phase.completed');
    expect(started.map((p) => p.payload.phase).sort()).toEqual(['release', 'review', 'test']);
    expect(completed.map((p) => p.payload.phase).sort()).toEqual(['release', 'review', 'test']);
  });
});
