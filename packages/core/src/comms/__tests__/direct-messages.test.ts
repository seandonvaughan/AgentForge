/**
 * Unit tests for the DM helpers — sendDirectMessage + groupDirectMessagesIntoThreads.
 *
 * Backed by an in-memory WorkspaceAdapter so we exercise the real SQL path
 * without mocking. See `docs/v2-architecture/agent-comm-and-kb-spec.md`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';
import {
  sendDirectMessage,
  listDirectMessagesForAgent,
  groupDirectMessagesIntoThreads,
} from '../direct-messages.js';

let adapter: WorkspaceAdapter;

beforeEach(() => {
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
});

describe('sendDirectMessage', () => {
  it('persists a DM and returns the fully materialised record', () => {
    const dm = sendDirectMessage(adapter, {
      from: 'coder-1',
      to: 'architect',
      body: 'should I extend WorkspaceAdapter or fork?',
    });

    expect(dm.id).toMatch(/.+/);
    expect(dm.fromAgent).toBe('coder-1');
    expect(dm.toAgent).toBe('architect');
    expect(dm.body).toBe('should I extend WorkspaceAdapter or fork?');
    expect(dm.replyToId).toBeNull();
    expect(dm.deliveredAt).toBeNull();
    expect(dm.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects empty from/to/body', () => {
    expect(() => sendDirectMessage(adapter, { from: '', to: 'a', body: 'b' })).toThrow(/from/);
    expect(() => sendDirectMessage(adapter, { from: 'a', to: '', body: 'b' })).toThrow(/to/);
    expect(() => sendDirectMessage(adapter, { from: 'a', to: 'b', body: '   ' })).toThrow(/body/);
  });

  it('rejects self-DMs', () => {
    expect(() => sendDirectMessage(adapter, { from: 'a', to: 'a', body: 'hi' })).toThrow(/differ/);
  });

  it('threads replies via replyToId', () => {
    const parent = sendDirectMessage(adapter, { from: 'a', to: 'b', body: 'question' });
    const child = sendDirectMessage(adapter, {
      from: 'b',
      to: 'a',
      body: 'answer',
      replyToId: parent.id,
    });
    expect(child.replyToId).toBe(parent.id);
  });

  it('rejects replyToId pointing at a non-existent message', () => {
    expect(() =>
      sendDirectMessage(adapter, {
        from: 'a',
        to: 'b',
        body: 'x',
        replyToId: 'does-not-exist',
      }),
    ).toThrow(/not found/);
  });
});

describe('listDirectMessagesForAgent', () => {
  it('returns DMs sent to OR by the agent, oldest first', () => {
    sendDirectMessage(adapter, { from: 'a', to: 'b', body: 'first' });
    sendDirectMessage(adapter, { from: 'b', to: 'a', body: 'second' });
    sendDirectMessage(adapter, { from: 'c', to: 'd', body: 'third (not us)' });

    const aDms = listDirectMessagesForAgent(adapter, 'a');
    expect(aDms).toHaveLength(2);
    expect(aDms[0]?.body).toBe('first');
    expect(aDms[1]?.body).toBe('second');
  });

  it('returns an empty array for an agent with no DMs', () => {
    expect(listDirectMessagesForAgent(adapter, 'nobody')).toEqual([]);
  });
});

describe('groupDirectMessagesIntoThreads', () => {
  it('groups a reply chain into a single thread', () => {
    const root = sendDirectMessage(adapter, { from: 'a', to: 'b', body: 'q1' });
    sendDirectMessage(adapter, { from: 'b', to: 'a', body: 'r1', replyToId: root.id });
    sendDirectMessage(adapter, { from: 'a', to: 'b', body: 'q2 (new thread)' });

    const list = listDirectMessagesForAgent(adapter, 'a');
    const threads = groupDirectMessagesIntoThreads(list);

    expect(threads).toHaveLength(2);
    const twoMsgThread = threads.find((t) => t.messages.length === 2);
    expect(twoMsgThread).toBeDefined();
    expect(twoMsgThread!.messages.map((m) => m.body)).toEqual(['q1', 'r1']);
  });
});
