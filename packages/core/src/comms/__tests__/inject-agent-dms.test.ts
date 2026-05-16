/**
 * Tests for `injectAgentDms` — the prompt-injection round-trip.
 *
 * This is the integration test for ADR 0001: write a DM via the helper, run
 * the injector against a fresh prompt, verify the recipient sees the block,
 * and verify the row is marked `delivered_at` so a second injection is a
 * no-op.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';
import { sendDirectMessage } from '../direct-messages.js';
import { injectAgentDms, buildAgentDmsBlock } from '../inject-agent-dms.js';

let adapter: WorkspaceAdapter;
const BASE_PROMPT = 'You are the architect. Respond with reasoning, not directives.';

beforeEach(() => {
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
});

describe('injectAgentDms', () => {
  it('returns the prompt unchanged when no DMs are pending', () => {
    const result = injectAgentDms(BASE_PROMPT, 'architect', adapter);
    expect(result).toBe(BASE_PROMPT);
  });

  it('appends a Direct Messages section and marks the row delivered', () => {
    const dm = sendDirectMessage(adapter, {
      from: 'coder-1',
      to: 'architect',
      body: 'extend adapter or fork?',
    });

    const injected = injectAgentDms(BASE_PROMPT, 'architect', adapter);
    expect(injected).toContain('## Direct Messages (1 new)');
    expect(injected).toContain('**coder-1**');
    expect(injected).toContain('extend adapter or fork?');

    // The row should now be delivered.
    const row = adapter.getDirectMessage(dm.id);
    expect(row?.delivered_at).not.toBeNull();
  });

  it('does not re-inject already-delivered DMs', () => {
    sendDirectMessage(adapter, {
      from: 'coder-1',
      to: 'architect',
      body: 'first',
    });

    const first = injectAgentDms(BASE_PROMPT, 'architect', adapter);
    expect(first).toContain('first');

    const second = injectAgentDms(BASE_PROMPT, 'architect', adapter);
    expect(second).toBe(BASE_PROMPT);
  });

  it('only injects DMs addressed to the recipient', () => {
    sendDirectMessage(adapter, { from: 'a', to: 'b', body: 'for-b' });
    sendDirectMessage(adapter, { from: 'a', to: 'c', body: 'for-c' });

    const forB = injectAgentDms(BASE_PROMPT, 'b', adapter);
    expect(forB).toContain('for-b');
    expect(forB).not.toContain('for-c');
  });

  it('honours maxMessages bound', () => {
    for (let i = 0; i < 15; i++) {
      sendDirectMessage(adapter, {
        from: `coder-${i}`,
        to: 'architect',
        body: `body-${i}`,
      });
    }
    const result = injectAgentDms(BASE_PROMPT, 'architect', adapter, { maxMessages: 3 });
    expect(result).toContain('## Direct Messages (3 new)');
    expect(result).toContain('body-0');
    expect(result).toContain('body-2');
    expect(result).not.toContain('body-3');

    // 12 should still be pending — the remaining batch is available next call.
    const remaining = adapter.listDirectMessages({
      toAgent: 'architect',
      undeliveredOnly: true,
    });
    expect(remaining.length).toBe(12);
  });

  it('preserves pending rows when markDelivered=false', () => {
    sendDirectMessage(adapter, {
      from: 'coder-1',
      to: 'architect',
      body: 'preview only',
    });
    injectAgentDms(BASE_PROMPT, 'architect', adapter, { markDelivered: false });
    const pending = adapter.listDirectMessages({
      toAgent: 'architect',
      undeliveredOnly: true,
    });
    expect(pending).toHaveLength(1);
  });

  it('truncates over-long bodies with an ellipsis', () => {
    const longBody = 'x'.repeat(5000);
    sendDirectMessage(adapter, { from: 'coder', to: 'architect', body: longBody });
    const { block } = buildAgentDmsBlock(adapter, 'architect', { maxBodyChars: 100 });
    expect(block).toContain('…');
    // 100-char cap (99 chars + ellipsis) — the slice should be much shorter
    // than the original 5000-char string.
    expect(block.length).toBeLessThan(2000);
  });
});
