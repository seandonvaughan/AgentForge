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
  SelfModificationCanaryLifecyclePayload,
} from '@agentforge/core';
import {
  bridgeDmToGlobalStream,
  bridgeInboxToGlobalStream,
  bridgeSelfModificationCanaryToGlobalStream,
} from '../index.js';
import { globalStream, type StreamEvent } from '../stream.js';

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

function selfModificationCanaryEnvelope(
  topic: 'self-modification.canary.staged' | 'self-modification.canary.promoted' | 'self-modification.canary.rolled_back',
  payload: SelfModificationCanaryLifecyclePayload,
): MessageEnvelopeV2<SelfModificationCanaryLifecyclePayload> {
  return {
    id: 'env-3',
    version: '2.0',
    timestamp: '2026-05-15T00:00:00.000Z',
    workspaceId: 'test',
    from: 'system',
    to: 'broadcast',
    topic,
    category: 'system',
    priority: 'normal',
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

describe('bridgeSelfModificationCanaryToGlobalStream', () => {
  it('emits a workflow_event for staged/promoted/rolled-back canary lifecycle messages', () => {
    const received: StreamEvent[] = [];
    const unsub = globalStream.subscribe('test-selfmod-canary-bridge', (e) => received.push(e));
    try {
      bridgeSelfModificationCanaryToGlobalStream(
        selfModificationCanaryEnvelope('self-modification.canary.staged', {
          agentName: 'runtime-engineer',
          planId: 'plan-1',
          flagId: 'flag-1',
          trafficPercent: 10,
          strategy: 'hash',
          rollbackThreshold: 0.1,
          canaryRequests: 0,
          canaryErrors: 0,
          errorRate: 0,
        }),
      );
      bridgeSelfModificationCanaryToGlobalStream(
        selfModificationCanaryEnvelope('self-modification.canary.promoted', {
          agentName: 'runtime-engineer',
          planId: 'plan-1',
          flagId: 'flag-1',
          trafficPercent: 10,
          strategy: 'hash',
          rollbackThreshold: 0.1,
          canaryRequests: 8,
          canaryErrors: 0,
          errorRate: 0,
        }),
      );
      bridgeSelfModificationCanaryToGlobalStream(
        selfModificationCanaryEnvelope('self-modification.canary.rolled_back', {
          agentName: 'runtime-engineer',
          planId: 'plan-1',
          flagId: 'flag-1',
          trafficPercent: 10,
          strategy: 'hash',
          rollbackThreshold: 0.1,
          canaryRequests: 5,
          canaryErrors: 3,
          errorRate: 0.6,
          rollbackReason: 'error rate above threshold',
        }),
      );
    } finally {
      unsub();
    }

    expect(received).toHaveLength(3);
    expect(received.every((ev) => ev.type === 'workflow_event')).toBe(true);
    expect(received[0]!.message).toContain('staged');
    expect(received[1]!.message).toContain('promoted');
    expect(received[2]!.message).toContain('rolled back');
    const payload = received[2]!.payload as { topic: string; rollbackReason?: string };
    expect(payload.topic).toBe('self-modification.canary.rolled_back');
    expect(payload.rollbackReason).toContain('threshold');
  });
});
