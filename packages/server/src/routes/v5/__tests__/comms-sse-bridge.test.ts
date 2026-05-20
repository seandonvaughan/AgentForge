/**
 * Tests for the Phase-2 bus → SSE bridge: `agent.dm.sent` and
 * `inbox.message.created` envelopes published on `MessageBusV2` must surface
 * on `globalStream` as `comms_event` notifications. The dashboard `/inbox`
 * page subscribes to this stream for live updates.
 */
import { describe, it, expect } from 'vitest';
import type { MessageEnvelopeV2 } from '@agentforge/core';
import type {
  AgentDmSentPayload,
  InboxMessageCreatedPayload,
} from '@agentforge/core';
import {
  bridgeDmToGlobalStream,
  bridgeInboxToGlobalStream,
} from '../index.js';
import { globalStream, type StreamEvent } from '../stream.js';

function dmEnvelope(
  payload: AgentDmSentPayload,
  trace: { traceId?: string; spanId?: string; parentSpanId?: string; traceparent?: string } = {},
): MessageEnvelopeV2<AgentDmSentPayload> {
  return {
    id: 'env-1',
    version: '2.0',
    timestamp: '2026-05-15T00:00:00.000Z',
    workspaceId: 'test',
    from: payload.fromAgent,
    to: payload.toAgent,
    topic: 'agent.dm.sent',
    category: 'comms',
    priority: 'normal',
    payload,
    ...trace,
  };
}

function inboxEnvelope(
  payload: InboxMessageCreatedPayload,
  trace: { traceId?: string; spanId?: string; parentSpanId?: string; traceparent?: string } = {},
): MessageEnvelopeV2<InboxMessageCreatedPayload> {
  return {
    id: 'env-2',
    version: '2.0',
    timestamp: '2026-05-15T00:00:00.000Z',
    workspaceId: 'test',
    from: 'system',
    to: 'broadcast',
    topic: 'inbox.message.created',
    category: 'comms',
    priority: 'normal',
    payload,
    ...trace,
  };
}

describe('bridgeDmToGlobalStream', () => {
  it('emits a comms_event with the DM payload shape', () => {
    const received: StreamEvent[] = [];
    const unsub = globalStream.subscribe('test-dm-bridge', (e) => received.push(e));
    try {
      bridgeDmToGlobalStream(
        dmEnvelope({
          id: 'dm-1',
          fromAgent: 'coder-1',
          toAgent: 'architect',
          body: 'design review please',
          replyToId: null,
          sentAt: '2026-05-15T00:00:00.000Z',
        }, {
          traceId: 'trace-dm-1',
          spanId: 'span-dm-1',
          parentSpanId: 'span-parent-1',
          traceparent: '00|trace-dm-1|span-dm-1|01',
        }),
      );
    } finally {
      unsub();
    }
    expect(received).toHaveLength(1);
    const ev = received[0]!;
    expect(ev.type).toBe('comms_event');
    expect(ev.category).toBe('comms');
    expect(ev.workspaceId).toBe('test');
    expect(ev.traceId).toBe('trace-dm-1');
    expect(ev.message).toContain('coder-1');
    expect(ev.message).toContain('architect');
    const payload = ev.payload as {
      kind: string;
      fromAgent: string;
      toAgent: string;
      id: string;
      traceId: string;
      spanId: string;
      parentSpanId: string;
      traceparent: string;
    };
    expect(payload.kind).toBe('dm');
    expect(payload.id).toBe('dm-1');
    expect(payload.fromAgent).toBe('coder-1');
    expect(payload.toAgent).toBe('architect');
    expect(payload.traceId).toBe('trace-dm-1');
    expect(payload.spanId).toBe('span-dm-1');
    expect(payload.parentSpanId).toBe('span-parent-1');
    expect(payload.traceparent).toBe('00|trace-dm-1|span-dm-1|01');
  });
});

describe('bridgeInboxToGlobalStream', () => {
  it('emits a comms_event with the inbox payload shape', () => {
    const received: StreamEvent[] = [];
    const unsub = globalStream.subscribe('test-inbox-bridge', (e) => received.push(e));
    try {
      bridgeInboxToGlobalStream(
        inboxEnvelope({
          id: 'inbox-1',
          body: 'budget warning 80%',
          kind: 'warning',
          sourceId: 'cycle-42',
          sourceType: 'cost-warning',
          threadId: null,
          createdAt: '2026-05-15T00:00:00.000Z',
          recipients: ['@user'],
        }, {
          traceId: 'trace-inbox-1',
          spanId: 'span-inbox-1',
          traceparent: '00|trace-inbox-1|span-inbox-1|01',
        }),
      );
    } finally {
      unsub();
    }
    expect(received).toHaveLength(1);
    const ev = received[0]!;
    expect(ev.type).toBe('comms_event');
    expect(ev.category).toBe('comms');
    expect(ev.workspaceId).toBe('test');
    expect(ev.traceId).toBe('trace-inbox-1');
    const payload = ev.payload as {
      kind: string;
      id: string;
      messageKind: string;
      recipients: string[];
      traceId: string;
      spanId: string;
      traceparent: string;
    };
    expect(payload.kind).toBe('inbox');
    expect(payload.id).toBe('inbox-1');
    expect(payload.messageKind).toBe('warning');
    expect(payload.recipients).toEqual(['@user']);
    expect(payload.traceId).toBe('trace-inbox-1');
    expect(payload.spanId).toBe('span-inbox-1');
    expect(payload.traceparent).toBe('00|trace-inbox-1|span-inbox-1|01');
  });
});
