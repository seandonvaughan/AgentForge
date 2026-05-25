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
  SelfModificationCanaryStagedPayload,
} from '@agentforge/core';
import {
  bridgeDmToGlobalStream,
  bridgeInboxToGlobalStream,
  bridgeCanaryLifecycleToGlobalStream,
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

function canaryStagedEnvelope(
  payload: SelfModificationCanaryStagedPayload,
): MessageEnvelopeV2<SelfModificationCanaryStagedPayload> {
  return {
    id: 'env-3',
    version: '2.0',
    timestamp: '2026-05-15T00:00:00.000Z',
    workspaceId: 'test',
    from: 'system',
    to: 'broadcast',
    topic: 'self-modification.canary.staged',
    category: 'quality',
    priority: 'high',
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

describe('bridgeCanaryLifecycleToGlobalStream', () => {
  it('emits a workflow_event with canary lifecycle payload shape', () => {
    const received: StreamEvent[] = [];
    const unsub = globalStream.subscribe('test-canary-bridge', (e) => received.push(e));
    try {
      bridgeCanaryLifecycleToGlobalStream(
        canaryStagedEnvelope({
          agentName: 'cost-analyst',
          planId: 'plan-1',
          flagId: 'plan-1:cost-analyst',
          trafficPercent: 25,
          strategy: 'hash',
          rollbackThreshold: 0.1,
          stagedAt: '2026-05-15T00:00:00.000Z',
          overrideVersion: 3,
          mutationCount: 2,
        }),
      );
    } finally {
      unsub();
    }

    expect(received).toHaveLength(1);
    const ev = received[0]!;
    expect(ev.type).toBe('workflow_event');
    expect(ev.category).toBe('quality');
    expect(ev.message).toContain('Self-mod canary staged');
    const payload = ev.payload as { kind: string; topic: string; agentName: string; flagId: string };
    expect(payload.kind).toBe('self_mod_canary_staged');
    expect(payload.topic).toBe('self-modification.canary.staged');
    expect(payload.agentName).toBe('cost-analyst');
    expect(payload.flagId).toBe('plan-1:cost-analyst');
  });
});
