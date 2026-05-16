/**
 * Tests for the v2 Phase-2 bus integration of the comms helpers.
 *
 * `sendDirectMessage` publishes `agent.dm.sent`; `sendInboxMessage`
 * publishes `inbox.message.created`. Both topics are routed through
 * MessageBusV2 so the dashboard's SSE consumer gets live updates without
 * polling.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';
import { MessageBusV2 } from '../../message-bus/index.js';
import type {
  AgentDmSentEnvelope,
  InboxMessageCreatedEnvelope,
} from '../../message-bus/types.js';
import { sendDirectMessage } from '../direct-messages.js';
import { sendInboxMessage } from '../inbox.js';

let adapter: WorkspaceAdapter;
let bus: MessageBusV2;

beforeEach(() => {
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
  bus = new MessageBusV2({ workspaceId: 'test' });
});

describe('sendDirectMessage publishes agent.dm.sent', () => {
  it('emits an envelope after persistence with the DM payload', () => {
    const received: AgentDmSentEnvelope[] = [];
    bus.subscribe<AgentDmSentEnvelope['payload']>('agent.dm.sent', (env) => {
      received.push(env);
    });

    const dm = sendDirectMessage(
      adapter,
      { from: 'coder-1', to: 'architect', body: 'ping?' },
      bus,
    );

    expect(received).toHaveLength(1);
    const env = received[0]!;
    expect(env.topic).toBe('agent.dm.sent');
    expect(env.category).toBe('comms');
    expect(env.from).toBe('coder-1');
    expect(env.to).toBe('architect');
    expect(env.payload.id).toBe(dm.id);
    expect(env.payload.fromAgent).toBe('coder-1');
    expect(env.payload.toAgent).toBe('architect');
    expect(env.payload.body).toBe('ping?');
    expect(env.payload.replyToId).toBeNull();
    expect(env.payload.sentAt).toBe(dm.sentAt);
  });

  it('does not publish when no bus is passed', () => {
    const received: unknown[] = [];
    bus.subscribe('agent.dm.sent', (env) => { received.push(env); });
    sendDirectMessage(adapter, { from: 'a', to: 'b', body: 'silent' });
    expect(received).toHaveLength(0);
  });
});

describe('sendInboxMessage publishes inbox.message.created', () => {
  it('emits an envelope including recipients[] after the row commits', () => {
    const received: InboxMessageCreatedEnvelope[] = [];
    bus.subscribe<InboxMessageCreatedEnvelope['payload']>(
      'inbox.message.created',
      (env) => { received.push(env); },
    );

    const { message } = sendInboxMessage(
      adapter,
      {
        body: 'budget warning 80%',
        kind: 'warning',
        sourceType: 'cost-warning',
        sourceId: 'cycle-7',
        recipients: ['@user'],
      },
      { bus },
    );

    expect(received).toHaveLength(1);
    const env = received[0]!;
    expect(env.topic).toBe('inbox.message.created');
    expect(env.category).toBe('comms');
    expect(env.payload.id).toBe(message.id);
    expect(env.payload.body).toBe('budget warning 80%');
    expect(env.payload.kind).toBe('warning');
    expect(env.payload.sourceType).toBe('cost-warning');
    expect(env.payload.recipients).toEqual(['@user']);
  });

  it('does not publish when no bus is passed in options', () => {
    const received: unknown[] = [];
    bus.subscribe('inbox.message.created', (env) => { received.push(env); });
    sendInboxMessage(adapter, {
      body: 'silent',
      kind: 'info',
      recipients: ['@user'],
    });
    expect(received).toHaveLength(0);
  });
});

describe('bus publish failure does not undo the persisted row', () => {
  it('returns the DM even when a subscriber throws', () => {
    bus.subscribe('agent.dm.sent', () => {
      throw new Error('subscriber blew up');
    });
    // MessageBusV2.dispatch() catches handler errors via void promise, so the
    // synchronous throw should not surface here — but even if it did, the row
    // is already persisted. Assert both the API contract + the side-effect.
    const dm = sendDirectMessage(
      adapter,
      { from: 'a', to: 'b', body: 'still saved' },
      bus,
    );
    expect(dm.id).toMatch(/.+/);
    const row = adapter.getDirectMessage(dm.id);
    expect(row?.body).toBe('still saved');
  });
});
