/**
 * Tests for `buildCcDmDirectiveBlock` — T3.5 CC-native DM delivery bridge.
 *
 * Covers:
 *   - 2 undelivered DMs → block contains both, formatted with the spec header.
 *   - 0 undelivered DMs → empty string.
 *   - Both DMs marked delivered after call (delivery side-effect).
 *   - DMs to OTHER agents are not included.
 *   - maxMessages cap is respected.
 *   - markDelivered=false preserves the queue.
 *   - Long bodies are truncated with an ellipsis.
 *   - Multi-line bodies are blockquoted per line.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';
import { sendDirectMessage } from '../direct-messages.js';
import { buildCcDmDirectiveBlock } from '../cc-dm-bridge.js';

let adapter: WorkspaceAdapter;

beforeEach(() => {
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendDm(from: string, to: string, body: string) {
  return sendDirectMessage(adapter, { from, to, body });
}

function undeliveredCount(agentId: string): number {
  return adapter.listDirectMessages({ toAgent: agentId, undeliveredOnly: true }).length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildCcDmDirectiveBlock — no pending DMs', () => {
  it('returns an empty string when the agent has no undelivered DMs', () => {
    const result = buildCcDmDirectiveBlock({ agentId: 'architect', adapter });
    expect(result).toBe('');
  });
});

describe('buildCcDmDirectiveBlock — happy path', () => {
  it('includes both DMs when 2 are pending for the agent', () => {
    sendDm('coder-1', 'architect', 'should we refactor the adapter?');
    sendDm('reviewer', 'architect', 'LGTM on the last PR');

    const block = buildCcDmDirectiveBlock({ agentId: 'architect', adapter });

    expect(block).toContain('## Pending messages for you');
    expect(block).toContain('`coder-1`');
    expect(block).toContain('should we refactor the adapter?');
    expect(block).toContain('`reviewer`');
    expect(block).toContain('LGTM on the last PR');
    // Must end with the separator line
    expect(block).toMatch(/---\n$/);
  });

  it('formats bodies as blockquotes (> prefix)', () => {
    sendDm('coder-1', 'architect', 'single line body');
    const block = buildCcDmDirectiveBlock({ agentId: 'architect', adapter });
    expect(block).toContain('> single line body');
  });

  it('includes the sender and ISO timestamp in the header line', () => {
    const dm = sendDm('coder-1', 'architect', 'hello');
    const block = buildCcDmDirectiveBlock({ agentId: 'architect', adapter });
    // Header: **From `<sender>` at <sentAt>:**
    expect(block).toContain(`**From \`coder-1\` at ${dm.sentAt}:**`);
  });
});

describe('buildCcDmDirectiveBlock — delivery side-effects', () => {
  it('marks both DMs delivered after call', () => {
    const dm1 = sendDm('coder-1', 'architect', 'message A');
    const dm2 = sendDm('coder-2', 'architect', 'message B');

    expect(undeliveredCount('architect')).toBe(2);
    buildCcDmDirectiveBlock({ agentId: 'architect', adapter });

    const row1 = adapter.getDirectMessage(dm1.id);
    const row2 = adapter.getDirectMessage(dm2.id);
    expect(row1?.delivered_at).not.toBeNull();
    expect(row2?.delivered_at).not.toBeNull();
  });

  it('does NOT re-deliver on a second call after the first consumed the queue', () => {
    sendDm('coder-1', 'architect', 'first');
    buildCcDmDirectiveBlock({ agentId: 'architect', adapter });
    const second = buildCcDmDirectiveBlock({ agentId: 'architect', adapter });
    expect(second).toBe('');
  });
});

describe('buildCcDmDirectiveBlock — agent isolation', () => {
  it('does not include DMs addressed to other agents', () => {
    sendDm('coder-1', 'architect', 'for architect only');
    sendDm('coder-1', 'reviewer', 'for reviewer only');

    const block = buildCcDmDirectiveBlock({ agentId: 'architect', adapter });
    expect(block).toContain('for architect only');
    expect(block).not.toContain('for reviewer only');
  });
});

describe('buildCcDmDirectiveBlock — options', () => {
  it('respects maxMessages cap', () => {
    for (let i = 0; i < 6; i++) {
      sendDm(`sender-${i}`, 'architect', `body-${i}`);
    }
    const block = buildCcDmDirectiveBlock({
      agentId: 'architect',
      adapter,
      maxMessages: 3,
    });
    // Only 3 of the 6 messages should appear.
    expect(block).toContain('body-0');
    expect(block).toContain('body-2');
    expect(block).not.toContain('body-3');
    // The remaining 3 are still undelivered.
    expect(undeliveredCount('architect')).toBe(3);
  });

  it('skips marking delivered when markDelivered=false', () => {
    sendDm('coder-1', 'architect', 'preview only');
    buildCcDmDirectiveBlock({ agentId: 'architect', adapter, markDelivered: false });
    expect(undeliveredCount('architect')).toBe(1);
  });

  it('truncates long bodies with an ellipsis', () => {
    const longBody = 'x'.repeat(5000);
    sendDm('coder-1', 'architect', longBody);
    const block = buildCcDmDirectiveBlock({
      agentId: 'architect',
      adapter,
      maxBodyChars: 100,
    });
    expect(block).toContain('…');
    // Truncated body should be far shorter than the original.
    expect(block.length).toBeLessThan(2000);
  });
});

describe('buildCcDmDirectiveBlock — multi-line body quoting', () => {
  it('blockquotes each line of a multi-line body', () => {
    sendDm('coder-1', 'architect', 'line one\nline two\nline three');
    const block = buildCcDmDirectiveBlock({ agentId: 'architect', adapter });
    expect(block).toContain('> line one');
    expect(block).toContain('> line two');
    expect(block).toContain('> line three');
  });
});
