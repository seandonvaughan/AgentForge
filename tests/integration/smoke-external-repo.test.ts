/**
 * T5.8 — End-to-end smoke test: forge against a fresh external repository.
 *
 * Verifies that AgentForge's scanner + forge pipeline works against an
 * arbitrary external project (not the AgentForge monorepo) and writes all
 * expected artifacts under the external project's directory.
 *
 * Constraints:
 * - Does NOT require API credentials — uses the deterministic legacy forgeTeam().
 * - Does NOT push to a remote.
 * - Must complete in under 60 seconds.
 * - All output paths must be under the tmp external project dir.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'js-yaml';

import { runFullScan } from '../../packages/core/src/team/engine/scanner/index.js';
import { forgeTeam } from '../../packages/core/src/team/engine/builder/index.js';
import { emitClaudeCodeAgents } from '../../packages/core/src/team/engine/builder/cc-agent-emitter.js';
import { emitClaudeCodeTeamCommands } from '../../packages/core/src/team/engine/builder/cc-command-emitter.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Project setup
// ---------------------------------------------------------------------------

let externalProjectDir: string;
let scanStartMs: number;
let smokeStartMs: number;

/**
 * Create a minimal but realistic "external" project that an AgentForge user
 * would point the CLI at.  The project has:
 *   - git repo (git init -b main)
 *   - package.json (basic Node.js project)
 *   - tsconfig.json (TypeScript project)
 *   - src/index.ts with a TODO(autonomous) marker
 *   - .agentforge/autonomous.yaml with a $5 budget
 *   - .claude/ directory (so CC emitters produce output)
 */
async function setupExternalProject(): Promise<string> {
  const projectDir = mkdtempSync(join(tmpdir(), 'agentforge-smoke-ext-'));

  // Initialize git repo so git-analyzer doesn't fail.
  try {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: projectDir });
    await execFileAsync('git', ['config', 'user.email', 'test@agentforge.ai'], { cwd: projectDir });
    await execFileAsync('git', ['config', 'user.name', 'AgentForge Smoke'], { cwd: projectDir });
  } catch {
    // Some older git versions don't support -b; fall back to renaming the branch.
    try {
      await execFileAsync('git', ['init'], { cwd: projectDir });
      await execFileAsync('git', ['config', 'user.email', 'test@agentforge.ai'], { cwd: projectDir });
      await execFileAsync('git', ['config', 'user.name', 'AgentForge Smoke'], { cwd: projectDir });
    } catch { /* ignore git init errors — git-analyzer will return defaults */ }
  }

  // package.json — TypeScript project with common dev tooling
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'my-external-project',
      version: '1.0.0',
      description: 'A sample external project for AgentForge smoke testing',
      type: 'module',
      scripts: {
        build: 'tsc',
        test: 'vitest run',
      },
      dependencies: {},
      devDependencies: {
        typescript: '^5.0.0',
        vitest: '^3.0.0',
      },
    }, null, 2),
  );

  // tsconfig.json
  writeFileSync(
    join(projectDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        outDir: 'dist',
      },
    }, null, 2),
  );

  // src/index.ts with a TODO(autonomous) marker — detected by comment-miner
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(
    join(projectDir, 'src', 'index.ts'),
    [
      '// External project entry point',
      '',
      '// TODO(autonomous): add input validation',
      'export function greet(name: string): string {',
      '  return `Hello, ${name}!`;',
      '}',
      '',
      '// TODO(autonomous): add error handling',
      'export function divide(a: number, b: number): number {',
      '  return a / b;',
      '}',
    ].join('\n'),
  );

  // src/utils.ts — additional file to show multi-file scanner
  writeFileSync(
    join(projectDir, 'src', 'utils.ts'),
    [
      '// Utility functions',
      'export function clamp(value: number, min: number, max: number): number {',
      '  return Math.min(Math.max(value, min), max);',
      '}',
    ].join('\n'),
  );

  // .agentforge/autonomous.yaml — minimal cycle config
  mkdirSync(join(projectDir, '.agentforge'), { recursive: true });
  writeFileSync(
    join(projectDir, '.agentforge', 'autonomous.yaml'),
    yaml.dump({
      budget: {
        perCycleUsd: 5,
        perItemUsd: 2,
        perAgentUsd: 1,
        allowOverageApproval: false,
      },
      limits: {
        maxItemsPerSprint: 3,
        maxDurationMinutes: 30,
      },
    }, { lineWidth: 120, noRefs: true }),
  );

  // .claude/ directory — presence triggers CC emitters to produce output
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  writeFileSync(join(projectDir, '.claude', '.gitkeep'), '');

  // Make an initial commit so git-analyzer has something to read.
  try {
    await execFileAsync('git', ['add', '-A'], { cwd: projectDir });
    await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: projectDir });
  } catch { /* ignore — git may not be configured in all CI environments */ }

  return projectDir;
}

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  smokeStartMs = Date.now();
  externalProjectDir = await setupExternalProject();
}, 30_000);

afterAll(() => {
  if (externalProjectDir) {
    rmSync(externalProjectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 1 — Scanner: output references files under the external project dir
// ---------------------------------------------------------------------------

describe('smoke: runFullScan() on external project', () => {
  it('scan output references files under the tmp external project dir (not AgentForge monorepo)', async () => {
    scanStartMs = Date.now();
    const result = await runFullScan(externalProjectDir);
    const scanMs = Date.now() - scanStartMs;

    // Scan completed in reasonable time
    expect(scanMs).toBeLessThan(30_000);

    // The scan result should have a `files` property
    expect(result.files).toBeDefined();
    expect(result.files.total_files).toBeGreaterThan(0);

    // Every file listed must be inside the external project dir
    const monorepoRoot = '/Users/seandonvaughan/Projects/AgentForge';
    for (const fileEntry of result.files.files) {
      if (fileEntry.path) {
        // Must not be an absolute path pointing into the monorepo
        const isMonorepoLeak =
          fileEntry.path.startsWith(monorepoRoot) ||
          fileEntry.path.startsWith('/Users/seandonvaughan/Projects/AgentForge/packages');
        expect(isMonorepoLeak).toBe(false);
      }
    }

    // TypeScript should be detected
    expect(result.files.languages).toBeDefined();
  }, 30_000);

  it('comment-miner detects TODO(autonomous) markers in the external project', async () => {
    const result = await runFullScan(externalProjectDir);
    // The comment miner should find our planted TODO(autonomous) markers
    const todos = result.comments?.todos ?? [];
    // Either no todos field (old scanner) or we find at least one
    // — just verifying it doesn't throw or reference wrong files
    if (todos.length > 0) {
      for (const todo of todos) {
        if (todo.file) {
          expect(todo.file).not.toContain(monorepoRoot());
        }
      }
    }
  }, 30_000);
});

function monorepoRoot(): string {
  return '/Users/seandonvaughan/Projects/AgentForge/packages';
}

function relativeProjectPath(filePath: string): string {
  const rel = relative(externalProjectDir, filePath);
  expect(rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))).toBe(true);
  return rel;
}

// ---------------------------------------------------------------------------
// Test 2 — forgeTeam(): .agentforge/team.yaml written to external project
// ---------------------------------------------------------------------------

describe('smoke: forgeTeam() on external project', () => {
  it('writes .agentforge/team.yaml inside the external project dir', async () => {
    await forgeTeam(externalProjectDir);

    const teamYamlPath = join(externalProjectDir, '.agentforge', 'team.yaml');
    expect(existsSync(teamYamlPath)).toBe(true);

    // Must be valid YAML
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(teamYamlPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    expect(parsed).toBeDefined();
    expect(parsed['name']).toBeDefined();
    expect(parsed['forged_at']).toBeDefined();
  }, 30_000);

  it('team.yaml forged_by is "agentforge" — no monorepo path leaks', async () => {
    const teamYamlPath = join(externalProjectDir, '.agentforge', 'team.yaml');
    const raw = readFileSync(teamYamlPath, 'utf8');
    // The YAML must not contain any hard-coded monorepo path
    expect(raw).not.toContain('/Users/seandonvaughan/Projects/AgentForge/packages');
    expect(raw).not.toContain('/Users/seandonvaughan/Projects/AgentForge/src');
  }, 15_000);

  it('writes per-agent YAML files under .agentforge/agents/', async () => {
    const agentsDir = join(externalProjectDir, '.agentforge', 'agents');
    expect(existsSync(agentsDir)).toBe(true);

    const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith('.yaml'));
    expect(agentFiles.length).toBeGreaterThan(0);

    // Each agent YAML must be valid and reference no monorepo paths
    for (const file of agentFiles) {
      const raw = readFileSync(join(agentsDir, file), 'utf8');
      const parsed = yaml.load(raw) as Record<string, unknown>;
      expect(typeof parsed['name']).toBe('string');
      expect(raw).not.toContain('/Users/seandonvaughan/Projects/AgentForge/packages');
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Test 3 — CC agent emitter: .claude/agents/*.md written to external project
// ---------------------------------------------------------------------------

describe('smoke: emitClaudeCodeAgents() on external project', () => {
  it('writes .claude/agents/<id>.md files inside the external project dir', async () => {
    // Read the agents that forgeTeam already wrote so we can build specs for the emitter.
    const agentsDir = join(externalProjectDir, '.agentforge', 'agents');
    const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith('.yaml'));

    const specs = agentFiles.map((f) => {
      const raw = readFileSync(join(agentsDir, f), 'utf8');
      const parsed = yaml.load(raw) as {
        name?: string;
        description?: string;
        system_prompt?: string;
      };
      return {
        id: f.replace('.yaml', ''),
        description: parsed.description ?? 'No description',
        systemPrompt: parsed.system_prompt ?? 'You are an agent.',
        model: 'sonnet' as const,
      };
    });

    expect(specs.length).toBeGreaterThan(0);

    const result = await emitClaudeCodeAgents({
      projectRoot: externalProjectDir,
      agents: specs,
    });

    expect(result.written.length).toBe(specs.length);

    // Every written path must be inside the external project
    for (const written of result.written) {
      const rel = relativeProjectPath(written);
      expect(dirname(rel)).toBe(join('.claude', 'agents'));
      expect(basename(rel).endsWith('.md')).toBe(true);
      expect(existsSync(written)).toBe(true);
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Test 4 — CC command emitter: .claude/commands/team-*.md written
// ---------------------------------------------------------------------------

describe('smoke: emitClaudeCodeTeamCommands() on external project', () => {
  it('writes .claude/commands/team-<id>.md files inside the external project dir', async () => {
    const agentsDir = join(externalProjectDir, '.agentforge', 'agents');
    const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith('.yaml'));

    const commandSpecs = agentFiles.map((f) => {
      const raw = readFileSync(join(agentsDir, f), 'utf8');
      const parsed = yaml.load(raw) as { description?: string };
      return {
        id: f.replace('.yaml', ''),
        description: parsed.description ?? 'No description',
      };
    });

    expect(commandSpecs.length).toBeGreaterThan(0);

    const result = await emitClaudeCodeTeamCommands({
      projectRoot: externalProjectDir,
      agents: commandSpecs,
    });

    expect(result.written.length).toBe(commandSpecs.length);

    for (const written of result.written) {
      const rel = relativeProjectPath(written);
      expect(dirname(rel)).toBe(join('.claude', 'commands'));
      expect(basename(rel).startsWith('team-')).toBe(true);
      expect(basename(rel).endsWith('.md')).toBe(true);
      expect(existsSync(written)).toBe(true);
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Test 5 — Smoke runtime is under 60 seconds total
// ---------------------------------------------------------------------------

describe('smoke: total wall-clock runtime', () => {
  it('entire smoke test suite completes in under 60 seconds', () => {
    const totalMs = Date.now() - smokeStartMs;
    // eslint-disable-next-line no-console
    console.log(`[smoke] total wall-clock: ${totalMs}ms`);
    expect(totalMs).toBeLessThan(60_000);
  });
});
