/**
 * End-to-end round-trip test: send → inject → mark delivered → re-inject no-op.
 *
 * This is the integration story for ADR 0001 — the DM lifecycle is the v1
 * acceptance signal for the agent-comm spec ("a coder agent sends a DM to
 * architect, architect's next invocation sees it, marker advances").
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';
import { sendDirectMessage } from '../direct-messages.js';
import { injectFreshContext } from '../../agent-runtime/fresh-context.js';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
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
