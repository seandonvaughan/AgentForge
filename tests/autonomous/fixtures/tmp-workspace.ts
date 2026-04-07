// tests/autonomous/fixtures/tmp-workspace.ts
//
// Helper for integration tests that need a throwaway AgentForge workspace
// on disk. Creates a tmp dir pre-wired with:
//
//   .agentforge/sprints/v6.3.5.json   — seed sprint so SprintGenerator can
//                                       find a "latest" version to bump from
//   .agentforge/autonomous.yaml       — cheap $5 budget so any overflow is
//                                       immediately obvious
//   .agentforge/agents/               — empty placeholder
//   src/sample.ts                     — contains a TODO(autonomous) marker so
//                                       ProposalToBacklog produces at least
//                                       one item and the PLAN stage does not
//                                       short-circuit on "no backlog"
//   sample.test.ts                    — trivial passing vitest test so the
//                                       real test runner (if used) succeeds
//   package.json                      — minimal test:run script so the config
//                                       loader is happy
//   git repo (init -b main)           — initial commit so the cycle has a
//                                       clean base branch to work from
//
// This is a dedicated fixture — NOT a reusable harness — so the values are
// intentionally fixed (v6.3.5 seed, $5 budget). Tests that need different
// shapes should extend this file, not parametrize it.
//
// Usage:
//   const tmpWorkspace = await setupTmpAgentforgeWorkspace();
//   try { ... } finally { rmSync(tmpWorkspace, { recursive: true, force: true }); }
//
// See tests/autonomous/integration/full-cycle.test.ts (Task 24) for the
// primary consumer.

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Stand up a fresh tmp AgentForge workspace on disk with seed data + a git
 * repo. Always returns an absolute path to the workspace root. Caller is
 * responsible for removing the directory (e.g., in `afterAll`).
 */
export async function setupTmpAgentforgeWorkspace(): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'agentforge-full-cycle-'));

  // --- Directory skeleton ---------------------------------------------------
  mkdirSync(join(tmp, '.agentforge/sprints'), { recursive: true });
  mkdirSync(join(tmp, '.agentforge/agents'), { recursive: true });
  mkdirSync(join(tmp, 'src'), { recursive: true });

  // --- package.json ---------------------------------------------------------
  // The RealTestRunner reads config.testing.command ('npm run test:run') so
  // we expose that script. We don't actually run vitest in the E2E test
  // (testRunner is stubbed), but the script presence makes the workspace
  // shape realistic.
  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify(
      {
        name: 'tmp-workspace',
        version: '6.3.5',
        type: 'module',
        scripts: { 'test:run': 'vitest run' },
        devDependencies: { vitest: '^3.0.4' },
      },
      null,
      2,
    ),
  );

  // --- Seed sprint ----------------------------------------------------------
  // SprintGenerator.findLatestSprintVersion() parses filenames matching
  // ^v\d+(\.\d+)*\.json$, so the filename is what determines the next
  // version, not the file contents. The contents are a lightweight stub
  // shaped like the real SprintFile so curious test readers can grok it.
  writeFileSync(
    join(tmp, '.agentforge/sprints/v6.3.5.json'),
    JSON.stringify(
      {
        sprints: [
          {
            sprintId: 'v6-3-5-seed',
            version: '6.3.5',
            title: 'Seed sprint',
            createdAt: new Date().toISOString(),
            phase: 'completed',
            items: [],
          },
        ],
      },
      null,
      2,
    ),
  );

  // --- autonomous.yaml ------------------------------------------------------
  // Cheap ($5) budget so any accidental cost leak blows past the cap
  // immediately and the kill switch fires. Other fields are left to the
  // DEFAULT_CYCLE_CONFIG merge in loadCycleConfig.
  writeFileSync(
    join(tmp, '.agentforge/autonomous.yaml'),
    `budget:\n  perCycleUsd: 5\n  perItemUsd: 2\n`,
  );

  // --- Seeded TODO marker ---------------------------------------------------
  // The ProposalToBacklog scanner walks cwd looking for TODO(autonomous)
  // markers in .ts/.tsx/.js files. We need at least one so PLAN stage
  // produces a non-empty backlog and the cycle can proceed.
  writeFileSync(
    join(tmp, 'src/sample.ts'),
    `// TODO(autonomous): add a meaningful comment to this file\nexport const x = 1;\n`,
  );

  // --- Trivial passing test -------------------------------------------------
  // Only relevant if a test actually spins up the RealTestRunner (Task 24
  // stubs it out). Left here so the workspace is runnable for future
  // smoke tests.
  writeFileSync(
    join(tmp, 'sample.test.ts'),
    `import { test, expect } from 'vitest';\ntest('passes', () => expect(1).toBe(1));\n`,
  );

  // --- git repo init --------------------------------------------------------
  // `-b main` makes sure the initial branch matches the default baseBranch
  // in DEFAULT_CYCLE_CONFIG. The gpg-sign disable is so the commit does not
  // block on a signing key in CI environments.
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: tmp });
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmp });
  await execFileAsync('git', ['add', '.'], { cwd: tmp });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: tmp });

  return tmp;
}
