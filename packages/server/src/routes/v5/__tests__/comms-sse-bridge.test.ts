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
  bridgeCanaryToGlobalStream,
} from '../index.js';
import { globalStream, type StreamEvent } from '../stream.js';

interface ReforgeCanaryOutcomePayload {
  planId: string;
  agentName: string;
  flagId: string;
  requestId: string;
  isError: boolean;
  canaryRequests: number;
  canaryErrors: number;
  errorRate: number;
  rollbackThreshold: number;
  status: 'healthy' | 'degraded' | 'rolled_back';
}

interface ReforgeCanaryEnvelope<TPayload> {
  workspaceId: string;
  topic: 'reforge.canary.outcome';
  payload: TPayload;
}

function dmEnvelope(
  payload: AgentDmSentPayload,
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
  };
}

function inboxEnvelope(
  payload: InboxMessageCreatedPayload,
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
  };
}

function canaryEnvelope(
  payload: ReforgeCanaryOutcomePayload,
): ReforgeCanaryEnvelope<ReforgeCanaryOutcomePayload> {
  return {
    workspaceId: 'test',
    topic: 'reforge.canary.outcome',
    payload,
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
        }),
      );
    } finally {
      unsub();
    }
    expect(received).toHaveLength(1);
    const ev = received[0]!;
    expect(ev.type).toBe('comms_event');
    expect(ev.category).toBe('comms');
    expect(ev.message).toContain('coder-1');
    expect(ev.message).toContain('architect');
    const payload = ev.payload as { kind: string; fromAgent: string; toAgent: string; id: string };
    expect(payload.kind).toBe('dm');
    expect(payload.id).toBe('dm-1');
    expect(payload.fromAgent).toBe('coder-1');
    expect(payload.toAgent).toBe('architect');
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
        }),
      );
    } finally {
      unsub();
    }
    expect(received).toHaveLength(1);
    const ev = received[0]!;
    expect(ev.type).toBe('comms_event');
    expect(ev.category).toBe('comms');
    const payload = ev.payload as {
      kind: string;
      id: string;
      messageKind: string;
      recipients: string[];
    };
    expect(payload.kind).toBe('inbox');
    expect(payload.id).toBe('inbox-1');
    expect(payload.messageKind).toBe('warning');
    expect(payload.recipients).toEqual(['@user']);
  });
});

describe('bridgeCanaryToGlobalStream', () => {
  it('emits a system event with the canary summary payload', () => {
    const received: StreamEvent[] = [];
    const unsub = globalStream.subscribe('test-canary-bridge', (e) => received.push(e));
    try {
      bridgeCanaryToGlobalStream(
        canaryEnvelope({
          planId: 'plan-1',
          agentName: 'coder',
          flagId: 'flag-1',
          requestId: 'req-1',
          isError: false,
          canaryRequests: 4,
          canaryErrors: 0,
          errorRate: 0,
          rollbackThreshold: 0.1,
          status: 'healthy',
        }),
      );
    } finally {
      unsub();
    }

    expect(received).toHaveLength(1);
    const ev = received[0]!;
    expect(ev.type).toBe('system');
    expect(ev.category).toBe('reforge');
    const payload = ev.payload as {
      kind: string;
      topic: string;
      agentName: string;
      requestId: string;
    };
    expect(payload.kind).toBe('canary');
    expect(payload.topic).toBe('reforge.canary.outcome');
    expect(payload.agentName).toBe('coder');
    expect(payload.requestId).toBe('req-1');
  });
});
