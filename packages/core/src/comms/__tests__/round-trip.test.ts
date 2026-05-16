/**
 * End-to-end round-trip test: send → inject → mark delivered → re-inject no-op.
 *
 * This is the integration story for ADR 0001 — the DM lifecycle is the v1
 * acceptance signal for the agent-comm spec ("a coder agent sends a DM to
 * architect, architect's next invocation sees it, marker advances").
 *
 * Phase 2 adds an additional case: `loadAgentConfig` threads the workspace
 * adapter into `injectFreshContext` so DMs are delivered during real agent
 * invocations (not just from tests calling `injectFreshContext` directly).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';
import { sendDirectMessage } from '../direct-messages.js';
import { injectFreshContext } from '../../agent-runtime/fresh-context.js';
import { loadAgentConfig } from '../../agent-runtime/agent-factory.js';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let adapter: WorkspaceAdapter;
let agentforgeDir: string;

beforeEach(() => {
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
  agentforgeDir = mkdtempSync(join(tmpdir(), 'agentforge-rt-'));
});

describe('Agent-comm round-trip', () => {
  it('injectFreshContext appends a Direct Messages section when adapter is provided', () => {
    const dm = sendDirectMessage(adapter, {
      from: 'coder-1',
      to: 'architect',
      body: 'design question: extend or fork?',
    });

    const prompt = 'You are the architect.';
    const enriched = injectFreshContext(prompt, 'architect', agentforgeDir, { adapter });
    expect(enriched).toContain('You are the architect.');
    expect(enriched).toContain('## Direct Messages');
    expect(enriched).toContain('coder-1');
    expect(enriched).toContain('design question');

    // The DM row is marked delivered, so a second call should produce the
    // original prompt unchanged.
    const second = injectFreshContext(prompt, 'architect', agentforgeDir, { adapter });
    expect(second).toBe(prompt);

    // ...and the adapter agrees the row is delivered.
    const row = adapter.getDirectMessage(dm.id);
    expect(row?.delivered_at).not.toBeNull();
  });

  it('injectFreshContext without adapter behaves exactly as before', () => {
    sendDirectMessage(adapter, {
      from: 'coder-1',
      to: 'architect',
      body: 'should be invisible without adapter',
    });
    const enriched = injectFreshContext('You are the architect.', 'architect', agentforgeDir);
    expect(enriched).toBe('You are the architect.');
  });

  it('loadAgentConfig delivers DMs to a real agent and marks rows delivered', async () => {
    // Stand up a real .agentforge/agents/architect.yaml so loadAgentConfig
    // can resolve it from disk — this is the production call path that the
    // autonomous runtime + /api/v5/run + /api/v5/agents/:id/invoke all use.
    const agentsDir = join(agentforgeDir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'architect.yaml'),
      [
        'name: Architect',
        'model: sonnet',
        'system_prompt: You are the architect agent for tests.',
      ].join('\n'),
      'utf8',
    );

    const dm = sendDirectMessage(adapter, {
      from: 'coder-1',
      to: 'architect',
      body: 'plan: should the new bus topic live in core or server?',
    });

    const config = await loadAgentConfig('architect', agentforgeDir, { adapter });
    expect(config).not.toBeNull();
    expect(config?.systemPrompt).toContain('You are the architect agent for tests.');
    expect(config?.systemPrompt).toContain('## Direct Messages');
    expect(config?.systemPrompt).toContain('coder-1');
    expect(config?.systemPrompt).toContain('plan: should the new bus topic');

    // delivered_at is now set on the DM row — the second loadAgentConfig
    // call MUST NOT re-deliver the same DM into the prompt.
    const row = adapter.getDirectMessage(dm.id);
    expect(row?.delivered_at).not.toBeNull();

    const second = await loadAgentConfig('architect', agentforgeDir, { adapter });
    expect(second?.systemPrompt).not.toContain('## Direct Messages');
  });

  it('loadAgentConfig without adapter does not deliver DMs (Phase 1 behaviour preserved)', async () => {
    const agentsDir = join(agentforgeDir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'coder.yaml'),
      ['name: Coder', 'model: sonnet', 'system_prompt: You are the coder.'].join('\n'),
      'utf8',
    );

    sendDirectMessage(adapter, {
      from: 'architect',
      to: 'coder',
      body: 'undelivered DM that should not surface without an adapter',
    });

    const config = await loadAgentConfig('coder', agentforgeDir);
    expect(config?.systemPrompt).toBe('You are the coder.');
  });
});

// Clean up tmp dir at the end of the suite to avoid stragglers.
import { afterAll } from 'vitest';
afterAll(() => {
  try {
    rmSync(agentforgeDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
