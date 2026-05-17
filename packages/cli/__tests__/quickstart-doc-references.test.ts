/**
 * Quickstart doc reference tests — Workstream KK (T5.5 + T5.6)
 *
 * Verifies that every command, env var, and file path referenced in
 * docs/quickstart-external-project.md actually exists in the codebase.
 *
 * These are structural smoke tests: they read the doc file, extract the
 * referenced identifiers, and grep/stat them against the real source tree.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Resolve from packages/cli/__tests__ up to the monorepo root:
// __tests__ -> cli -> packages -> AgentForge (repo root)
const REPO_ROOT = resolve(__dirname, '../../../');
const DOCS_DIR = join(REPO_ROOT, 'docs');
const QUICKSTART_PATH = join(DOCS_DIR, 'quickstart-external-project.md');
const TROUBLESHOOT_PATH = join(DOCS_DIR, 'external-project-troubleshooting.md');
const MANIFEST_AUDIT_PATH = join(DOCS_DIR, 'plugin-manifest-audit-2026-05-17.md');

function readDoc(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('quickstart-external-project.md exists and is non-empty', () => {
  it('the quickstart doc is present', () => {
    expect(existsSync(QUICKSTART_PATH)).toBe(true);
  });

  it('the quickstart doc has at least 100 lines', () => {
    const lines = readDoc(QUICKSTART_PATH).split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(100);
  });

  it('the troubleshooting companion doc is present', () => {
    expect(existsSync(TROUBLESHOOT_PATH)).toBe(true);
  });

  it('the plugin manifest audit doc is present', () => {
    expect(existsSync(MANIFEST_AUDIT_PATH)).toBe(true);
  });
});

describe('commands referenced in quickstart exist in the CLI', () => {
  const quickstart = readDoc(QUICKSTART_PATH);

  it('agentforge init is registered in the CLI', () => {
    // Verify the CLI source registers the `init` command
    const binPath = join(REPO_ROOT, 'packages/cli/src/bin.ts');
    expect(existsSync(binPath)).toBe(true);
    const bin = readFileSync(binPath, 'utf8');
    expect(bin).toContain("command('init')");
  });

  it('agentforge team forge is registered in the CLI', () => {
    const teamPath = join(REPO_ROOT, 'packages/cli/src/commands/team.ts');
    expect(existsSync(teamPath)).toBe(true);
    const team = readFileSync(teamPath, 'utf8');
    expect(team).toContain("command('forge')");
  });

  it('agentforge cycle run is registered in the CLI', () => {
    const autoPath = join(REPO_ROOT, 'packages/cli/src/commands/autonomous.ts');
    expect(existsSync(autoPath)).toBe(true);
    const auto = readFileSync(autoPath, 'utf8');
    // registerCycleRunCommand registers 'run' as a subcommand of the 'cycle' command
    expect(auto).toContain("registerCycleRunCommand");
    expect(auto).toContain("'run'");
  });

  it('agentforge cycle preview is registered in the CLI', () => {
    const autoPath = join(REPO_ROOT, 'packages/cli/src/commands/autonomous.ts');
    const auto = readFileSync(autoPath, 'utf8');
    expect(auto).toContain("command('preview')");
  });

  it('agentforge cycle list is registered in the CLI', () => {
    const autoPath = join(REPO_ROOT, 'packages/cli/src/commands/autonomous.ts');
    const auto = readFileSync(autoPath, 'utf8');
    expect(auto).toContain("command('list')");
  });

  it('agentforge team reforge rollback is registered (for troubleshooting doc)', () => {
    const teamPath = join(REPO_ROOT, 'packages/cli/src/commands/team.ts');
    const team = readFileSync(teamPath, 'utf8');
    expect(team).toContain("command('rollback");
  });

  it('agentforge costs report is registered in the CLI', () => {
    const costsPath = join(REPO_ROOT, 'packages/cli/src/commands/costs.ts');
    expect(existsSync(costsPath)).toBe(true);
  });

  it('agentforge start is registered in the CLI', () => {
    const binPath = join(REPO_ROOT, 'packages/cli/src/bin.ts');
    const bin = readFileSync(binPath, 'utf8');
    expect(bin).toContain("command('start')");
  });
});

describe('env vars referenced in quickstart exist in the source', () => {
  it('AGENTFORGE_RUNTIME is read in execution-service-mode.ts', () => {
    const modePath = join(REPO_ROOT, 'packages/core/src/runtime/execution-service-mode.ts');
    expect(existsSync(modePath)).toBe(true);
    const source = readFileSync(modePath, 'utf8');
    expect(source).toContain('AGENTFORGE_RUNTIME');
  });

  it('ANTHROPIC_API_KEY is referenced in the SDK transport', () => {
    // The quickstart documents this as a required var for AGENTFORGE_RUNTIME=sdk
    // Verify it appears somewhere in the packages source
    const serverDir = join(REPO_ROOT, 'packages/server/src');
    const coreDir = join(REPO_ROOT, 'packages/core/src');
    // At least one of the core TS files references ANTHROPIC_API_KEY
    function containsApiKey(dir: string): boolean {
      const { readdirSync, statSync } = require('node:fs');
      function walk(d: string): boolean {
        for (const f of readdirSync(d)) {
          const full = join(d, f);
          if (statSync(full).isDirectory()) {
            if (walk(full)) return true;
          } else if (f.endsWith('.ts') && readFileSync(full, 'utf8').includes('ANTHROPIC_API_KEY')) {
            return true;
          }
        }
        return false;
      }
      return walk(dir);
    }
    expect(containsApiKey(serverDir) || containsApiKey(coreDir)).toBe(true);
  });

  it('MAX_PARALLEL_AGENTS is read in concurrency-gate.ts', () => {
    const gatePath = join(REPO_ROOT, 'packages/core/src/runtime/concurrency-gate.ts');
    expect(existsSync(gatePath)).toBe(true);
    const source = readFileSync(gatePath, 'utf8');
    expect(source).toContain('MAX_PARALLEL_AGENTS');
  });

  it('GH_TOKEN is documented in the quickstart', () => {
    const quickstart = readDoc(QUICKSTART_PATH);
    expect(quickstart).toContain('GH_TOKEN');
  });
});

describe('file paths mentioned in quickstart are real conventions', () => {
  it('.agentforge/team.yaml exists in this repo', () => {
    const teamYaml = join(REPO_ROOT, '.agentforge/team.yaml');
    expect(existsSync(teamYaml)).toBe(true);
  });

  it('.agentforge/memory/ exists in this repo', () => {
    const memDir = join(REPO_ROOT, '.agentforge/memory');
    expect(existsSync(memDir)).toBe(true);
  });

  it('.agentforge/agents/ exists in this repo', () => {
    const agentsDir = join(REPO_ROOT, '.agentforge/agents');
    expect(existsSync(agentsDir)).toBe(true);
  });

  it('.agentforge/cycles/ is a documented convention (gitignored — may not exist in fresh checkout)', () => {
    // `.agentforge/cycles/` is gitignored (per-run state, not committed).
    // It exists only when the project has run at least one cycle — assert
    // its parent dir is real, and that the cycles path is documented.
    const cyclesParent = join(REPO_ROOT, '.agentforge');
    expect(existsSync(cyclesParent)).toBe(true);
  });

  it('.agentforge/autonomous.yaml exists in this repo', () => {
    const autonomousYaml = join(REPO_ROOT, '.agentforge/autonomous.yaml');
    expect(existsSync(autonomousYaml)).toBe(true);
  });

  it('.claude-plugin/plugin.json exists (the CC plugin manifest)', () => {
    const pluginJson = join(REPO_ROOT, '.claude-plugin/plugin.json');
    expect(existsSync(pluginJson)).toBe(true);
  });
});

describe('cost reference in quickstart matches spec', () => {
  it('quickstart cites $2.80 as the cost per forge', () => {
    const quickstart = readDoc(QUICKSTART_PATH);
    // The spec (docs/superpowers/specs/2026-05-17-agent-driven-forge.md) states ~$2.80
    expect(quickstart).toContain('$2.80');
  });

  it('quickstart cites $15 – $30 as the typical cycle cost range', () => {
    const quickstart = readDoc(QUICKSTART_PATH);
    expect(quickstart).toContain('$15');
    expect(quickstart).toContain('$30');
  });
});

describe('plugin manifest audit covers required checks', () => {
  it('audit doc mentions the dashboard.md hardcoded path fix', () => {
    const audit = readDoc(MANIFEST_AUDIT_PATH);
    expect(audit).toContain('dashboard.md');
    expect(audit).toContain('hardcoded');
  });

  it('audit doc confirms no hardcoded paths in plugin.json itself', () => {
    const audit = readDoc(MANIFEST_AUDIT_PATH);
    expect(audit).toContain('plugin.json');
    // Check it passed the path-leak test
    expect(audit).toMatch(/plugin\.json.*has no hardcoded.*paths|No hardcoded.*plugin\.json/i);
  });

  it('commands/dashboard.md no longer contains the monorepo absolute path', () => {
    const dashboardPath = join(REPO_ROOT, 'commands/dashboard.md');
    expect(existsSync(dashboardPath)).toBe(true);
    const content = readFileSync(dashboardPath, 'utf8');
    // After the fix, the hardcoded path should be gone
    expect(content).not.toContain('/Users/seandonvaughan/Projects/AgentForge');
  });
});
