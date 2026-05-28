import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED_CYCLE_ID = '00000000-0000-4000-8000-000000000199';

function hasCycleLedger(cyclesDir) {
  if (!existsSync(cyclesDir)) return false;
  for (const entry of readdirSync(cyclesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (existsSync(join(cyclesDir, entry.name, 'cycle.json'))) return true;
  }
  return false;
}

function writeJson(file, data) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function writeJsonl(file, events) {
  writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
}

export default async function globalSetup() {
  const projectRoot = resolve(process.env.AGENTFORGE_E2E_PROJECT_ROOT ?? process.cwd());
  const cyclesDir = join(projectRoot, '.agentforge', 'cycles');
  if (hasCycleLedger(cyclesDir)) return;

  const startedAt = '2026-05-28T00:00:00.000Z';
  const completedAt = '2026-05-28T00:03:42.000Z';
  const cycleDir = join(cyclesDir, SEED_CYCLE_ID);
  const phasesDir = join(cycleDir, 'phases');
  mkdirSync(phasesDir, { recursive: true });

  writeJson(join(cycleDir, 'cycle.json'), {
    cycleId: SEED_CYCLE_ID,
    sprintVersion: 'e2e-fixture',
    stage: 'completed',
    status: 'completed',
    runtimeMode: 'codex-cli',
    branchPrefix: 'codex/',
    baseBranch: 'codex/codex-version',
    dryRun: false,
    maxAgents: 1,
    modelCap: 'sonnet',
    effortCap: 'medium',
    fallbackEnabled: false,
    startedAt,
    completedAt,
    durationMs: 222000,
    cost: {
      totalUsd: 1.23,
      budgetUsd: 10,
      byAgent: { 'cli-engineer': 1.23 },
      byPhase: { execute: 0.98, test: 0.25 },
    },
    tests: {
      passed: 3,
      failed: 0,
      skipped: 0,
      total: 3,
      passRate: 1,
      newFailures: [],
    },
    git: {
      branch: 'codex/e2e-fixture',
      commitSha: 'e2e-fixture',
      filesChanged: [
        'packages/dashboard/src/routes/cycles/[id]/+page.svelte',
        'tests/e2e/dashboard-cycle-detail.test.ts',
      ],
    },
    pr: {
      url: null,
      number: null,
      draft: false,
    },
    gateVerdict: 'APPROVE',
  });

  writeJson(join(cycleDir, 'plan.json'), {
    version: 'e2e-fixture',
    title: 'Dashboard cycle detail fixture',
    createdAt: startedAt,
    items: [
      {
        id: 'e2e-cycle-detail-001',
        title: 'Render deterministic cycle detail data',
        status: 'completed',
        assignee: 'cli-engineer',
        files: ['packages/dashboard/src/routes/cycles/[id]/+page.svelte'],
        estimatedCostUsd: 1.23,
      },
    ],
  });

  writeJson(join(phasesDir, 'execute.json'), {
    phase: 'execute',
    status: 'completed',
    costUsd: 0.98,
    durationMs: 120000,
    agentRuns: [
      {
        agentId: 'cli-engineer',
        itemId: 'e2e-cycle-detail-001',
        status: 'completed',
        costUsd: 0.98,
        durationMs: 120000,
        model: 'sonnet',
        effort: 'medium',
      },
    ],
  });

  writeJson(join(phasesDir, 'test.json'), {
    phase: 'test',
    status: 'completed',
    costUsd: 0.25,
    durationMs: 24000,
    passed: 3,
    failed: 0,
    total: 3,
  });

  writeJsonl(join(cycleDir, 'events.jsonl'), [
    { type: 'phase.result', phase: 'plan', at: startedAt, stage: 'plan', status: 'completed', message: 'E2E fixture planned one scoped item.' },
    { type: 'phase.result', phase: 'execute', at: '2026-05-28T00:01:20.000Z', stage: 'execute', status: 'completed', message: 'E2E fixture completed useful product work.' },
    { type: 'phase.result', phase: 'gate', at: completedAt, stage: 'gate', status: 'completed', message: 'Gate approved deterministic cycle fixture.' },
  ]);

  writeFileSync(join(cycleDir, 'cli-stdout.log'), 'E2E fixture cycle completed.\n', 'utf8');
  writeFileSync(join(cycleDir, 'tests-raw.log'), '3 passed, 0 failed\n', 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await globalSetup();
}
