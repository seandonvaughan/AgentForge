/**
 * Tests for `buildCcInboxBriefing` — T3.5 CC-native inbox summary bridge.
 *
 * Covers:
 *   - 5 unread inbox items → summary contains all 5.
 *   - 10 unread with limit=3 → only 3 lines in summary.
 *   - 0 unread → empty string.
 *   - Inbox messages are NOT marked as read before/after call.
 *   - Summary uses a truncated body as subject when body is long.
 *   - Heading is "## Inbox".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';
import { buildCcInboxBriefing } from '../cc-inbox-bridge.js';

let adapter: WorkspaceAdapter;

beforeEach(() => {
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createInboxItem(
  agentId: string,
  body: string,
  kind: 'info' | 'warning' | 'action_required' = 'info',
  sourceType?: string,
) {
  // Bypass the @user-only guard in the comms helper layer by calling the
  // adapter directly — consistent with how cc-inbox-bridge.ts works.
  return adapter.createInboxMessage({
    body,
    kind,
    sourceType: sourceType ?? null,
    recipients: [agentId],
  });
}

function unreadCount(agentId: string): number {
  return adapter.countInboxForRecipient(agentId, 'unread');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildCcInboxBriefing — no unread items', () => {
  it('returns an empty string when the agent has no unread inbox messages', () => {
    const result = buildCcInboxBriefing({ agentId: 'architect', adapter });
    expect(result).toBe('');
  });
});

describe('buildCcInboxBriefing — happy path', () => {
  it('returns a ## Inbox heading', () => {
    createInboxItem('architect', 'Budget 80% consumed', 'warning', 'cost-warning');
    const block = buildCcInboxBriefing({ agentId: 'architect', adapter });
    expect(block).toMatch(/^## Inbox/);
  });

  it('includes 5 items when exactly 5 are unread (default limit)', () => {
    for (let i = 0; i < 5; i++) {
      createInboxItem('architect', `Message ${i}`, 'info', `source-${i}`);
    }
    const block = buildCcInboxBriefing({ agentId: 'architect', adapter });
    const bulletLines = block.split('\n').filter((l) => l.startsWith('- '));
    expect(bulletLines).toHaveLength(5);
  });

  it('includes subject derived from the message body', () => {
    createInboxItem('architect', 'Gate verdict: PASSED', 'info', 'gate');
    const block = buildCcInboxBriefing({ agentId: 'architect', adapter });
    expect(block).toContain('Gate verdict: PASSED');
  });

  it('includes sender context (source_type or kind)', () => {
    createInboxItem('architect', 'Something happened', 'warning', 'cost-warning');
    const block = buildCcInboxBriefing({ agentId: 'architect', adapter });
    expect(block).toContain('cost-warning');
  });
});

describe('buildCcInboxBriefing — limit option', () => {
  it('returns only limit=3 items when 10 are unread', () => {
    for (let i = 0; i < 10; i++) {
      createInboxItem('architect', `Message body ${i}`, 'info', `src-${i}`);
    }
    const block = buildCcInboxBriefing({ agentId: 'architect', adapter, limit: 3 });
    const bulletLines = block.split('\n').filter((l) => l.startsWith('- '));
    expect(bulletLines).toHaveLength(3);
  });

  it('returns at most the actual count when limit > available', () => {
    createInboxItem('architect', 'Only one', 'info');
    const block = buildCcInboxBriefing({ agentId: 'architect', adapter, limit: 10 });
    const bulletLines = block.split('\n').filter((l) => l.startsWith('- '));
    expect(bulletLines).toHaveLength(1);
  });
});

describe('buildCcInboxBriefing — read status invariant', () => {
  it('does not mark inbox messages as read after building the briefing', () => {
    createInboxItem('architect', 'item A', 'info');
    createInboxItem('architect', 'item B', 'info');

    const beforeCount = unreadCount('architect');
    buildCcInboxBriefing({ agentId: 'architect', adapter });
    const afterCount = unreadCount('architect');

    expect(beforeCount).toBe(2);
    expect(afterCount).toBe(2); // unchanged — bridge is read-only
  });
});

describe('buildCcInboxBriefing — subject truncation', () => {
  it('truncates very long bodies to 80 chars with an ellipsis', () => {
    const longBody = 'A'.repeat(200);
    createInboxItem('architect', longBody, 'info');
    const block = buildCcInboxBriefing({ agentId: 'architect', adapter });
    // The summary line should not contain 200 A's.
    expect(block).not.toContain(longBody);
    // Should have an ellipsis
    expect(block).toContain('…');
  });

  it('does not truncate short bodies', () => {
    createInboxItem('architect', 'Short message', 'info');
    const block = buildCcInboxBriefing({ agentId: 'architect', adapter });
    expect(block).toContain('Short message');
    expect(block).not.toContain('…');
  });
});
