// W3 — learn phase closes the remaining learning loops:
//   1. refreshes cost-priors.json from spend-report actuals
//   2. auto-writes skill proposals (propose-only) from low-step-score clusters

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PhaseContext } from '../../phase-scheduler.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'af-learn-flywheel-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeCtx(): PhaseContext {
  return {
    projectRoot: root,
    sprintId: 'sprint-1',
    sprintVersion: '1.0.0',
    cycleId: 'cycle-1',
    adapter: undefined,
    bus: { publish: vi.fn(), subscribe: () => () => {} },
    runtime: {
      run: vi.fn().mockResolvedValue({ output: '## Retro\nAll good.', costUsd: 0.05 }),
    },
  } as unknown as PhaseContext;
}

it('writes cost-priors.json and skill proposals at the end of the learn phase', async () => {
  // Seed spend-report actuals (≥3 completed samples with complexity).
  const cycleDir = join(root, '.agentforge', 'cycles', 'cycle-0');
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(
    join(cycleDir, 'spend-report.json'),
    JSON.stringify({
      perItem: [
        { itemId: 'a', status: 'completed', actualUsd: 2.0, estimatedComplexity: 'low' },
        { itemId: 'b', status: 'completed', actualUsd: 4.0, estimatedComplexity: 'medium' },
        { itemId: 'c', status: 'completed', actualUsd: 6.0, estimatedComplexity: 'high' },
      ],
    }),
  );

  // Seed low-quality step-scores (≥3 occurrences of one tag, mean < 0.55).
  const memDir = join(root, '.agentforge', 'memory');
  mkdirSync(memDir, { recursive: true });
  const rows = [
    { id: 's1', capability_tag: 'yaml-wrangling', step_score: 0.2 },
    { id: 's2', capability_tag: 'yaml-wrangling', step_score: 0.3 },
    { id: 's3', capability_tag: 'yaml-wrangling', step_score: 0.4 },
  ];
  writeFileSync(join(memDir, 'step-scores.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const { runLearnPhase } = await import('../learn-phase.js');
  const result = await runLearnPhase(makeCtx());
  expect(result.status).toBe('completed');

  // 1. priors written
  expect(existsSync(join(root, '.agentforge', 'config', 'cost-priors.json'))).toBe(true);

  // 2. proposals written under .agentforge/flywheel/proposals
  const proposalsDir = join(root, '.agentforge', 'flywheel', 'proposals');
  expect(existsSync(proposalsDir)).toBe(true);
  expect(readdirSync(proposalsDir).length).toBeGreaterThan(0);
});

it('degrades silently on a repo with no spend data and no step-scores', async () => {
  const { runLearnPhase } = await import('../learn-phase.js');
  const result = await runLearnPhase(makeCtx());
  expect(result.status).toBe('completed');
  expect(existsSync(join(root, '.agentforge', 'config', 'cost-priors.json'))).toBe(false);
  expect(existsSync(join(root, '.agentforge', 'flywheel', 'proposals'))).toBe(false);
});
