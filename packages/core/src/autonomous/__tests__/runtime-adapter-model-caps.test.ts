/**
 * Coverage for RuntimeAdapter.applyCaps() — modelCap and effortCap behavior.
 *
 * modelCap enables two scenarios:
 *   - Opus outage fallback: set to "sonnet" to keep cycles running without
 *     touching individual agent YAML files.
 *   - Cost-reduced runs: set to "sonnet" or "haiku" to cut spend on
 *     exploratory work.
 *
 * effortCap forces all agents to run at a single effort level regardless of
 * per-agent YAML configuration. Used for high-stakes runs (xhigh on all agents)
 * or low-cost exploration (low on all agents).
 *
 * This covers the gate-rejected test scenarios:
 *   1. same-tier: agent model already at or below cap — no change
 *   2. downgrade: agent model above cap — downgraded with effort:max
 *   3. xhigh-coerce: xhigh effort coerced to max for non-Opus models
 *   4. effortCap-independent: effortCap overrides per-agent effort
 *   5. fallback-chain: caps applied in fallback resolution
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeAdapter } from '../runtime-adapter.js';
import type { AgentRuntimeConfig } from '../../agent-runtime/types.js';

let tmpDir: string;
let agentsDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-model-caps-'));
  agentsDir = join(tmpDir, '.agentforge', 'agents');
  mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeAgentConfig(name: string, model: 'fable' | 'opus' | 'sonnet' | 'haiku', effort?: string): void {
  let yaml = `name: ${name}\nmodel: ${model}\nversion: '1.0'\ndescription: test agent\nsystem_prompt: test\n`;
  if (effort) {
    yaml += `effort: ${effort}\n`;
  }
  writeFileSync(join(agentsDir, `${name}.yaml`), yaml);
}

describe('RuntimeAdapter modelCap and applyCaps()', () => {
  describe('fable tier (above opus)', () => {
    it('leaves a fable agent unchanged when cap is fable', async () => {
      writeAgentConfig('fable-agent', 'fable');
      const adapter = new RuntimeAdapter({ cwd: tmpDir, modelCap: 'fable' });

      const runtime = await adapter['getOrCreateRuntime']('fable-agent');
      expect(runtime['config'].model).toBe('fable');
    });

    it('downgrades a fable agent to opus (with effort:max) when cap is opus', async () => {
      writeAgentConfig('fable-agent', 'fable');
      const adapter = new RuntimeAdapter({ cwd: tmpDir, modelCap: 'opus' });

      const runtime = await adapter['getOrCreateRuntime']('fable-agent');
      expect(runtime['config'].model).toBe('opus');
      expect(runtime['config'].effort).toBe('max');
    });

    it('keeps xhigh effort on a fable agent (xhigh is supported above sonnet)', async () => {
      writeAgentConfig('fable-agent', 'fable', 'xhigh');
      const adapter = new RuntimeAdapter({ cwd: tmpDir });

      const runtime = await adapter['getOrCreateRuntime']('fable-agent');
      expect(runtime['config'].model).toBe('fable');
      expect(runtime['config'].effort).toBe('xhigh');
    });

    it('leaves an opus agent unchanged when cap is fable (below cap)', async () => {
      writeAgentConfig('opus-agent', 'opus');
      const adapter = new RuntimeAdapter({ cwd: tmpDir, modelCap: 'fable' });

      const runtime = await adapter['getOrCreateRuntime']('opus-agent');
      expect(runtime['config'].model).toBe('opus');
    });
  });

  describe('same-tier: agent at or below cap', () => {
    it('leaves sonnet agent unchanged when cap is sonnet', async () => {
      writeAgentConfig('sonnet-agent', 'sonnet');
      const adapter = new RuntimeAdapter({ cwd: tmpDir, modelCap: 'sonnet' });

      const runtime = await adapter['getOrCreateRuntime']('sonnet-agent');
      // Verify the runtime uses the uncapped config
      expect(runtime['config'].model).toBe('sonnet');
      expect(runtime['config'].effort).toBeUndefined();
    });

    it('leaves haiku agent unchanged when cap is sonnet (below cap)', async () => {
      writeAgentConfig('haiku-agent', 'haiku');
      const adapter = new RuntimeAdapter({ cwd: tmpDir, modelCap: 'sonnet' });

      const runtime = await adapter['getOrCreateRuntime']('haiku-agent');
      expect(runtime['config'].model).toBe('haiku');
      expect(runtime['config'].effort).toBeUndefined();
    });

    it('leaves opus agent unchanged when cap is opus', async () => {
      writeAgentConfig('opus-agent', 'opus');
      const adapter = new RuntimeAdapter({ cwd: tmpDir, modelCap: 'opus' });

      const runtime = await adapter['getOrCreateRuntime']('opus-agent');
      expect(runtime['config'].model).toBe('opus');
      expect(runtime['config'].effort).toBeUndefined();
    });
  });

  describe('downgrade: agent above cap gets downgraded', () => {
    it('downgrades opus to sonnet and sets effort:max', async () => {
      writeAgentConfig('opus-agent', 'opus');
      const adapter = new RuntimeAdapter({ cwd: tmpDir, modelCap: 'sonnet' });

      const runtime = await adapter['getOrCreateRuntime']('opus-agent');
      expect(runtime['config'].model).toBe('sonnet');
      expect(runtime['config'].effort).toBe('max');
    });

    it('downgrades sonnet to haiku and sets effort:max', async () => {
      writeAgentConfig('sonnet-agent', 'sonnet');
      const adapter = new RuntimeAdapter({ cwd: tmpDir, modelCap: 'haiku' });

      const runtime = await adapter['getOrCreateRuntime']('sonnet-agent');
      expect(runtime['config'].model).toBe('haiku');
      expect(runtime['config'].effort).toBe('max');
    });

    it('downgrades opus to haiku and sets effort:max (largest jump)', async () => {
      writeAgentConfig('opus-agent', 'opus');
      const adapter = new RuntimeAdapter({ cwd: tmpDir, modelCap: 'haiku' });

      const runtime = await adapter['getOrCreateRuntime']('opus-agent');
      expect(runtime['config'].model).toBe('haiku');
      expect(runtime['config'].effort).toBe('max');
    });

    it('overrides per-agent effort with max when downgrading', async () => {
      // Agent specifies effort:xhigh, but gets downgraded from opus to sonnet
      writeAgentConfig('opus-agent', 'opus', 'xhigh');
      const adapter = new RuntimeAdapter({ cwd: tmpDir, modelCap: 'sonnet' });

      const runtime = await adapter['getOrCreateRuntime']('opus-agent');
      expect(runtime['config'].model).toBe('sonnet');
      // Downgrade overrides the per-agent effort:xhigh with effort:max
      expect(runtime['config'].effort).toBe('max');
    });
  });

  describe('xhigh-coerce: xhigh effort only on Opus', () => {
    it('preserves xhigh on Opus agents', async () => {
      writeAgentConfig('opus-agent', 'opus', 'xhigh');
      const adapter = new RuntimeAdapter({ cwd: tmpDir });

      const runtime = await adapter['getOrCreateRuntime']('opus-agent');
      expect(runtime['config'].model).toBe('opus');
      expect(runtime['config'].effort).toBe('xhigh');
    });

    it('coerces xhigh to max for Sonnet agents', async () => {
      writeAgentConfig('sonnet-agent', 'sonnet', 'xhigh');
      const adapter = new RuntimeAdapter({ cwd: tmpDir });

      const runtime = await adapter['getOrCreateRuntime']('sonnet-agent');
      expect(runtime['config'].model).toBe('sonnet');
      // xhigh is not supported on Sonnet; should be coerced to max
      expect(runtime['config'].effort).toBe('max');
    });

    it('coerces xhigh to max for Haiku agents', async () => {
      writeAgentConfig('haiku-agent', 'haiku', 'xhigh');
      const adapter = new RuntimeAdapter({ cwd: tmpDir });

      const runtime = await adapter['getOrCreateRuntime']('haiku-agent');
      expect(runtime['config'].model).toBe('haiku');
      expect(runtime['config'].effort).toBe('max');
    });

    it('preserves other effort levels (low, medium, high, max) on non-Opus', async () => {
      writeAgentConfig('sonnet-low', 'sonnet', 'low');
      writeAgentConfig('sonnet-medium', 'sonnet', 'medium');
      writeAgentConfig('sonnet-high', 'sonnet', 'high');
      writeAgentConfig('sonnet-max', 'sonnet', 'max');

      const adapter = new RuntimeAdapter({ cwd: tmpDir });

      let runtime = await adapter['getOrCreateRuntime']('sonnet-low');
      expect(runtime['config'].effort).toBe('low');

      adapter.clearCache();
      runtime = await adapter['getOrCreateRuntime']('sonnet-medium');
      expect(runtime['config'].effort).toBe('medium');

      adapter.clearCache();
      runtime = await adapter['getOrCreateRuntime']('sonnet-high');
      expect(runtime['config'].effort).toBe('high');

      adapter.clearCache();
      runtime = await adapter['getOrCreateRuntime']('sonnet-max');
      expect(runtime['config'].effort).toBe('max');
    });
  });

  describe('effortCap-independent: effortCap overrides per-agent effort', () => {
    it('forces all agents to low effort when effortCap is low', async () => {
      writeAgentConfig('opus-agent', 'opus', 'xhigh');
      writeAgentConfig('sonnet-agent', 'sonnet', 'high');
      writeAgentConfig('haiku-agent', 'haiku', 'medium');

      const adapter = new RuntimeAdapter({ cwd: tmpDir, effortCap: 'low' });

      let runtime = await adapter['getOrCreateRuntime']('opus-agent');
      expect(runtime['config'].effort).toBe('low');

      adapter.clearCache();
      runtime = await adapter['getOrCreateRuntime']('sonnet-agent');
      expect(runtime['config'].effort).toBe('low');

      adapter.clearCache();
      runtime = await adapter['getOrCreateRuntime']('haiku-agent');
      expect(runtime['config'].effort).toBe('low');
    });

    it('forces all agents to xhigh when effortCap is xhigh on Opus', async () => {
      writeAgentConfig('opus-agent', 'opus', 'low');
      const adapter = new RuntimeAdapter({ cwd: tmpDir, effortCap: 'xhigh' });

      const runtime = await adapter['getOrCreateRuntime']('opus-agent');
      expect(runtime['config'].model).toBe('opus');
      expect(runtime['config'].effort).toBe('xhigh');
    });

    it('coerces effortCap:xhigh to max for non-Opus agents', async () => {
      writeAgentConfig('sonnet-agent', 'sonnet', 'low');
      writeAgentConfig('haiku-agent', 'haiku', 'medium');

      const adapter = new RuntimeAdapter({ cwd: tmpDir, effortCap: 'xhigh' });

      let runtime = await adapter['getOrCreateRuntime']('sonnet-agent');
      // xhigh forced but coerced to max for Sonnet
      expect(runtime['config'].effort).toBe('max');

      adapter.clearCache();
      runtime = await adapter['getOrCreateRuntime']('haiku-agent');
      expect(runtime['config'].effort).toBe('max');
    });

    it('overrides agents that have no per-agent effort', async () => {
      writeAgentConfig('no-effort-agent', 'opus');
      const adapter = new RuntimeAdapter({ cwd: tmpDir, effortCap: 'high' });

      const runtime = await adapter['getOrCreateRuntime']('no-effort-agent');
      expect(runtime['config'].effort).toBe('high');
    });
  });

  describe('combined: modelCap + effortCap interact correctly', () => {
    it('applies both caps: downgrade model AND set effort', async () => {
      writeAgentConfig('opus-agent', 'opus', 'xhigh');
      const adapter = new RuntimeAdapter({
        cwd: tmpDir,
        modelCap: 'sonnet',
        effortCap: 'medium',
      });

      const runtime = await adapter['getOrCreateRuntime']('opus-agent');
      // modelCap causes downgrade from opus to sonnet with effort:max
      // effortCap then overrides to medium
      expect(runtime['config'].model).toBe('sonnet');
      expect(runtime['config'].effort).toBe('medium');
    });

    it('applies modelCap + effortCap with xhigh coercion', async () => {
      writeAgentConfig('sonnet-agent', 'sonnet', 'low');
      const adapter = new RuntimeAdapter({
        cwd: tmpDir,
        modelCap: 'haiku',
        effortCap: 'xhigh',
      });

      const runtime = await adapter['getOrCreateRuntime']('sonnet-agent');
      // modelCap downgrades sonnet to haiku
      // effortCap forces xhigh, but gets coerced to max for haiku
      expect(runtime['config'].model).toBe('haiku');
      expect(runtime['config'].effort).toBe('max');
    });
  });

  describe('fallback-chain: caps applied during fallback resolution', () => {
    it('applies modelCap to fallback agents when real agent not found', async () => {
      writeAgentConfig('coder', 'opus');
      const adapter = new RuntimeAdapter({ cwd: tmpDir, modelCap: 'sonnet' });

      // Request 'CodeAgent' which doesn't exist; falls back to 'coder'
      const runtime = await adapter['getOrCreateRuntime']('CodeAgent');
      expect(runtime['config'].model).toBe('sonnet');
      expect(runtime['config'].effort).toBe('max');
    });

    it('applies effortCap to fallback agents', async () => {
      writeAgentConfig('test-runner', 'opus', 'xhigh');
      const adapter = new RuntimeAdapter({ cwd: tmpDir, effortCap: 'low' });

      // Request 'TestAgent' which doesn't exist; falls back to 'backend-qa'
      // (keyword-matched from the test-runner config)
      // Actually, let's write backend-qa instead:
      writeAgentConfig('backend-qa', 'opus', 'xhigh');
      const adapter2 = new RuntimeAdapter({ cwd: tmpDir, effortCap: 'low' });

      const runtime = await adapter2['getOrCreateRuntime']('TestAgent');
      expect(runtime['config'].effort).toBe('low');
    });

    it('applies both modelCap and effortCap to fallback agents', async () => {
      writeAgentConfig('coder', 'opus', 'xhigh');
      const adapter = new RuntimeAdapter({
        cwd: tmpDir,
        modelCap: 'sonnet',
        effortCap: 'medium',
      });

      // Request 'CodeAgent' which doesn't exist; falls back to 'coder'
      const runtime = await adapter['getOrCreateRuntime']('CodeAgent');
      expect(runtime['config'].model).toBe('sonnet');
      expect(runtime['config'].effort).toBe('medium');
    });
  });

  describe('registerInlineAgent: caps applied to inline configs', () => {
    it('applies modelCap to inline agents', () => {
      const inlineConfig: AgentRuntimeConfig = {
        agentId: 'inline-agent',
        name: 'Inline Agent',
        model: 'opus',
        systemPrompt: 'You are helpful.',
        workspaceId: 'test',
      };

      const adapter = new RuntimeAdapter({
        cwd: tmpDir,
        modelCap: 'sonnet',
      });

      adapter.registerInlineAgent('inline-agent', inlineConfig);
      const runtime = adapter['runtimes'].get('inline-agent');

      expect(runtime).toBeDefined();
      expect(runtime!['config'].model).toBe('sonnet');
      expect(runtime!['config'].effort).toBe('max');
    });

    it('applies effortCap to inline agents', () => {
      const inlineConfig: AgentRuntimeConfig = {
        agentId: 'inline-agent',
        name: 'Inline Agent',
        model: 'sonnet',
        systemPrompt: 'You are helpful.',
        workspaceId: 'test',
      };

      const adapter = new RuntimeAdapter({
        cwd: tmpDir,
        effortCap: 'high',
      });

      adapter.registerInlineAgent('inline-agent', inlineConfig);
      const runtime = adapter['runtimes'].get('inline-agent');

      expect(runtime).toBeDefined();
      expect(runtime!['config'].effort).toBe('high');
    });
  });

  describe('enableFallback: fallback model flag interaction', () => {
    it('threads enableFallback to run options when set', async () => {
      writeAgentConfig('coder', 'opus');
      const adapter = new RuntimeAdapter({
        cwd: tmpDir,
        enableFallback: true,
      });

      const runtime = await adapter['getOrCreateRuntime']('coder');
      // enableFallback is passed to RunOptions, not stored in the config
      // This test verifies the adapter is constructed with the flag set
      expect(adapter['options'].enableFallback).toBe(true);
    });

    it('defaults enableFallback to undefined (CLI default behavior)', async () => {
      writeAgentConfig('coder', 'sonnet');
      const adapter = new RuntimeAdapter({ cwd: tmpDir });

      // When not specified, enableFallback should be undefined
      expect(adapter['options'].enableFallback).toBeUndefined();
    });
  });

  describe('inlineAgents constructor option: caps applied via getOrCreateRuntime', () => {
    // Regression tests for a bug where configs passed via the `inlineAgents`
    // constructor option bypassed applyCaps() — unlike registerInlineAgent()
    // which always called applyCaps(). Both paths must honour modelCap/effortCap.

    it('applies modelCap to inlineAgents constructor config', async () => {
      const inlineAgents = {
        'inline-opus': {
          agentId: 'inline-opus',
          name: 'Inline Opus',
          model: 'opus' as const,
          systemPrompt: 'You are helpful.',
          workspaceId: 'test',
        },
      };

      const adapter = new RuntimeAdapter({
        cwd: tmpDir,
        modelCap: 'sonnet',
        inlineAgents,
      });

      // getOrCreateRuntime looks up the inlineAgents map, then must apply caps
      const runtime = await adapter['getOrCreateRuntime']('inline-opus');
      expect(runtime['config'].model).toBe('sonnet');
      expect(runtime['config'].effort).toBe('max');
    });

    it('applies effortCap to inlineAgents constructor config', async () => {
      const inlineAgents = {
        'inline-sonnet': {
          agentId: 'inline-sonnet',
          name: 'Inline Sonnet',
          model: 'sonnet' as const,
          systemPrompt: 'You are helpful.',
          workspaceId: 'test',
        },
      };

      const adapter = new RuntimeAdapter({
        cwd: tmpDir,
        effortCap: 'low',
        inlineAgents,
      });

      const runtime = await adapter['getOrCreateRuntime']('inline-sonnet');
      expect(runtime['config'].effort).toBe('low');
    });

    it('applies both modelCap and effortCap to inlineAgents constructor config', async () => {
      const inlineAgents = {
        'inline-opus-high': {
          agentId: 'inline-opus-high',
          name: 'Inline Opus High',
          model: 'opus' as const,
          effort: 'xhigh',
          systemPrompt: 'You are helpful.',
          workspaceId: 'test',
        },
      };

      const adapter = new RuntimeAdapter({
        cwd: tmpDir,
        modelCap: 'sonnet',
        effortCap: 'medium',
        inlineAgents,
      });

      const runtime = await adapter['getOrCreateRuntime']('inline-opus-high');
      // modelCap downgrades opus → sonnet
      expect(runtime['config'].model).toBe('sonnet');
      // effortCap overrides to medium
      expect(runtime['config'].effort).toBe('medium');
    });

    it('inlineAgents and registerInlineAgent produce identical capped configs', async () => {
      const baseConfig = {
        agentId: 'shared-agent',
        name: 'Shared Agent',
        model: 'opus' as const,
        systemPrompt: 'You are helpful.',
        workspaceId: 'test',
      };

      // Path 1: inlineAgents constructor option
      const adapter1 = new RuntimeAdapter({
        cwd: tmpDir,
        modelCap: 'haiku',
        inlineAgents: { 'shared-agent': { ...baseConfig } },
      });
      const runtime1 = await adapter1['getOrCreateRuntime']('shared-agent');

      // Path 2: registerInlineAgent method
      const adapter2 = new RuntimeAdapter({
        cwd: tmpDir,
        modelCap: 'haiku',
      });
      adapter2.registerInlineAgent('shared-agent', { ...baseConfig });
      const runtime2 = adapter2['runtimes'].get('shared-agent');

      // Both must produce the same capped config
      expect(runtime1['config'].model).toBe('haiku');
      expect(runtime2!['config'].model).toBe('haiku');
      expect(runtime1['config'].effort).toBe(runtime2!['config'].effort);
    });
  });
});
