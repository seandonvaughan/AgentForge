/**
 * Coverage for the RuntimeAdapter fallback resolution path.
 *
 * The scoring agent invents agent ids per cycle ("CodeAgent",
 * "feature-dev-agent", "DocsAgent", "general-purpose"). Without a fallback,
 * the execute phase would fail every cycle that scoring labels with a
 * non-canonical id. The fallback maps unknown ids to a default agent based
 * on simple keyword classification of the requested name. These tests pin
 * the classification rules.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeAdapter } from '../../../packages/core/src/autonomous/runtime-adapter.js';

let tmpDir: string;
let agentsDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-runtime-fb-'));
  agentsDir = join(tmpDir, '.agentforge', 'agents');
  mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeAgentConfig(name: string): void {
  writeFileSync(
    join(agentsDir, `${name}.yaml`),
    `name: ${name}\nmodel: sonnet\nversion: '1.0'\ndescription: test agent\nsystem_prompt: test\n`,
  );
}

describe('RuntimeAdapter fallback resolution', () => {
  it('returns the exact agent when the requested id matches a real file', async () => {
    writeAgentConfig('coder');
    const adapter = new RuntimeAdapter({ cwd: tmpDir });
    // Should not throw — the real config wins, no fallback consulted
    await expect(adapter['getOrCreateRuntime']('coder')).resolves.toBeDefined();
  });

  it('falls back to coder for unknown code-like agent ids', async () => {
    writeAgentConfig('coder');
    const adapter = new RuntimeAdapter({ cwd: tmpDir });
    // 'CodeAgent', 'feature-dev-agent', 'general-purpose' all classified as code work
    await expect(adapter['getOrCreateRuntime']('CodeAgent')).resolves.toBeDefined();
    await expect(adapter['getOrCreateRuntime']('feature-dev-agent')).resolves.toBeDefined();
    await expect(adapter['getOrCreateRuntime']('general-purpose')).resolves.toBeDefined();
  });

  it('falls back to documentation-writer for doc/writer-like ids', async () => {
    writeAgentConfig('documentation-writer');
    const adapter = new RuntimeAdapter({ cwd: tmpDir });
    await expect(adapter['getOrCreateRuntime']('DocsAgent')).resolves.toBeDefined();
    await expect(adapter['getOrCreateRuntime']('docs-writer')).resolves.toBeDefined();
    await expect(adapter['getOrCreateRuntime']('tech-writer')).resolves.toBeDefined();
  });

  it('falls back to backend-qa for test/qa-like ids', async () => {
    writeAgentConfig('backend-qa');
    const adapter = new RuntimeAdapter({ cwd: tmpDir });
    await expect(adapter['getOrCreateRuntime']('TestAgent')).resolves.toBeDefined();
    await expect(adapter['getOrCreateRuntime']('qa-engineer')).resolves.toBeDefined();
  });

  it('falls back to code-reviewer for review-like ids', async () => {
    writeAgentConfig('code-reviewer');
    const adapter = new RuntimeAdapter({ cwd: tmpDir });
    await expect(adapter['getOrCreateRuntime']('ReviewAgent')).resolves.toBeDefined();
    await expect(adapter['getOrCreateRuntime']('reviewer')).resolves.toBeDefined();
  });

  it('throws when neither the requested id NOR the fallback target exists', async () => {
    // No agents written at all — fallback also fails
    const adapter = new RuntimeAdapter({ cwd: tmpDir });
    await expect(adapter['getOrCreateRuntime']('totally-unknown')).rejects.toThrow(
      /Agent config not found/,
    );
  });
});
