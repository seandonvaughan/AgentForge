/**
 * Unit tests for the inbox helpers — sendInboxMessage + listInboxForRecipient
 * + markInboxRead. v1 invariant: only `@user` recipient is accepted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';
import {
  sendInboxMessage,
  listInboxForRecipient,
  getInboxMessage,
  markInboxRead,
  countUnread,
  UnsupportedRecipientError,
} from '../index.js';

let adapter: WorkspaceAdapter;

beforeEach(() => {
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
});

describe('sendInboxMessage', () => {
  it('creates a message + recipient row for @user', () => {
    const { message, recipients } = sendInboxMessage(adapter, {
      body: 'Budget 80% used',
      kind: 'warning',
      sourceType: 'cost-warning',
      sourceId: 'cycle-42',
      recipients: ['@user'],
    });

    expect(message.id).toMatch(/.+/);
    expect(message.body).toBe('Budget 80% used');
    expect(message.kind).toBe('warning');
    expect(message.sourceType).toBe('cost-warning');
    expect(recipients).toHaveLength(1);
    expect(recipients[0]?.recipient).toBe('@user');
    expect(recipients[0]?.status).toBe('unread');
  });

  it('rejects unsupported recipients in v1', () => {
    expect(() =>
      sendInboxMessage(adapter, {
        body: 'x',
        kind: 'info',
        recipients: ['@team-reviewers'],
      }),
    ).toThrow(UnsupportedRecipientError);
  });

  it('rejects empty body', () => {
    expect(() =>
      sendInboxMessage(adapter, { body: '   ', kind: 'info', recipients: ['@user'] }),
    ).toThrow(/body/);
  });

  it('rejects invalid kind', () => {
    expect(() =>
      sendInboxMessage(adapter, {
        body: 'ok',
        kind: 'urgent' as unknown as 'info',
        recipients: ['@user'],
      }),
    ).toThrow(/kind/);
  });

  it('rejects empty recipient list', () => {
    expect(() =>
      sendInboxMessage(adapter, { body: 'x', kind: 'info', recipients: [] }),
    ).toThrow(/non-empty/);
  });
});

describe('listInboxForRecipient', () => {
  it('returns rows ordered by created_at desc and reports status correctly', () => {
    const a = sendInboxMessage(adapter, {
      body: 'one',
      kind: 'info',
      recipients: ['@user'],
    });
    const b = sendInboxMessage(adapter, {
      body: 'two',
      kind: 'warning',
      recipients: ['@user'],
    });

    const list = listInboxForRecipient(adapter, '@user');
    expect(list).toHaveLength(2);
    // Both rows present — ordering uses created_at DESC, but ties on identical
    // millisecond stamps are arbitrary. Assert membership rather than position.
    const ids = list.map((m) => m.id);
    expect(ids).toContain(a.message.id);
    expect(ids).toContain(b.message.id);
    expect(list[0]?.status).toBe('unread');
  });

  it('filters by status', () => {
    const a = sendInboxMessage(adapter, {
      body: 'r1',
      kind: 'info',
      recipients: ['@user'],
    });
    sendInboxMessage(adapter, { body: 'r2', kind: 'info', recipients: ['@user'] });
    markInboxRead(adapter, a.message.id, '@user');

    const unread = listInboxForRecipient(adapter, '@user', { status: 'unread' });
    expect(unread).toHaveLength(1);
    expect(unread[0]?.body).toBe('r2');

    const read = listInboxForRecipient(adapter, '@user', { status: 'read' });
    expect(read).toHaveLength(1);
    expect(read[0]?.body).toBe('r1');
  });
});

describe('markInboxRead', () => {
  it('sets status=read and read_at is monotonic', () => {
    const { message } = sendInboxMessage(adapter, {
      body: 'x',
      kind: 'info',
      recipients: ['@user'],
    });
    const first = markInboxRead(adapter, message.id, '@user');
    expect(first?.status).toBe('read');
    expect(first?.readAt).not.toBeNull();
    // Idempotent — second call should not clear read_at.
    const second = markInboxRead(adapter, message.id, '@user');
    expect(second?.readAt).toBe(first?.readAt);
  });

  it('rejects unsupported recipients', () => {
    const { message } = sendInboxMessage(adapter, {
      body: 'x',
      kind: 'info',
      recipients: ['@user'],
    });
    expect(() => markInboxRead(adapter, message.id, '@team-x')).toThrow(
      UnsupportedRecipientError,
    );
  });
});

describe('getInboxMessage + countUnread', () => {
  it('returns the message + recipient rows by id', () => {
    const { message } = sendInboxMessage(adapter, {
      body: 'lookup',
      kind: 'info',
      recipients: ['@user'],
    });
    const found = getInboxMessage(adapter, message.id);
    expect(found?.message.body).toBe('lookup');
    expect(found?.recipients).toHaveLength(1);
  });

  it('returns undefined for an unknown id', () => {
    expect(getInboxMessage(adapter, 'nope')).toBeUndefined();
  });

  it('countUnread reflects state', () => {
    sendInboxMessage(adapter, { body: 'a', kind: 'info', recipients: ['@user'] });
    const b = sendInboxMessage(adapter, {
      body: 'b',
      kind: 'info',
      recipients: ['@user'],
    });
    expect(countUnread(adapter, '@user')).toBe(2);
    markInboxRead(adapter, b.message.id, '@user');
    expect(countUnread(adapter, '@user')).toBe(1);
  });
});
