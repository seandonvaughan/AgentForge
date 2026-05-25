/**
 * Tests for the InboxBridge — subscribes to bus topics and mirrors them
 * to the @user inbox per ADR 0004.
 *
 * v1 topic:  `cost.budget.warning`
 * Phase 2:   `gate.verdict.created`, `review.finding.created`
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';
import { MessageBusV2 } from '../../message-bus/index.js';
import type {
  CostBudgetWarningPayload,
  GateVerdictCreatedPayload,
  ReviewFindingCreatedPayload,
} from '../../message-bus/types.js';
import { InboxBridge } from '../inbox-bridge.js';
import { listInboxForRecipient } from '../inbox.js';

let adapter: WorkspaceAdapter;
let bus: MessageBusV2;
let bridge: InboxBridge;

beforeEach(() => {
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
  bus = new MessageBusV2({ workspaceId: 'test' });
  bridge = new InboxBridge({ bus, adapter });
  bridge.attach();
});

afterEach(() => {
  bridge.detach();
});

describe('InboxBridge', () => {
  it('mirrors cost.budget.warning into the @user inbox as warning kind', () => {
    bus.publish<CostBudgetWarningPayload>({
      from: 'system',
      to: 'broadcast',
      topic: 'cost.budget.warning',
      category: 'cost',
      payload: {
        workspaceId: 'test',
        budgetUsd: 50,
        spentUsd: 40.25,
        percentUsed: 80.5,
      },
    });

    const list = listInboxForRecipient(adapter, '@user');
    expect(list).toHaveLength(1);
    const msg = list[0];
    expect(msg).toBeDefined();
    expect(msg?.kind).toBe('warning');
    expect(msg?.sourceType).toBe('cost-warning');
    expect(msg?.body).toContain('$50.00');
    expect(msg?.body).toContain('80.5%');
  });

  it('detach() stops further mirroring', () => {
    bridge.detach();
    bus.publish<CostBudgetWarningPayload>({
      from: 'system',
      to: 'broadcast',
      topic: 'cost.budget.warning',
      category: 'cost',
      payload: { workspaceId: 'test', budgetUsd: 10, spentUsd: 9, percentUsed: 90 },
    });
    expect(listInboxForRecipient(adapter, '@user')).toHaveLength(0);
  });

  it('does not subscribe to unrelated topics', () => {
    bus.publish({
      from: 'system',
      to: 'broadcast',
      topic: 'cost.recorded',
      category: 'cost',
      payload: { foo: 'bar' },
    });
    expect(listInboxForRecipient(adapter, '@user')).toHaveLength(0);
  });

  it('attach() is idempotent', () => {
    // Calling attach twice should not double-deliver.
    bridge.attach();
    bus.publish<CostBudgetWarningPayload>({
      from: 'system',
      to: 'broadcast',
      topic: 'cost.budget.warning',
      category: 'cost',
      payload: { workspaceId: 'test', budgetUsd: 100, spentUsd: 90, percentUsed: 90 },
    });
    expect(listInboxForRecipient(adapter, '@user')).toHaveLength(1);
  });
});

describe('InboxBridge — gate.verdict.created mirroring (Phase 2 / ADR 0004)', () => {
  it('mirrors a REJECTED verdict as action_required', () => {
    bus.publish<GateVerdictCreatedPayload>({
      from: 'system',
      to: 'broadcast',
      topic: 'gate.verdict.created',
      category: 'quality',
      payload: {
        workspaceId: 'test',
        entryId: 'entry-rej-1',
        cycleId: 'cycle-v2.4',
        verdict: 'rejected',
        rationale: 'Two CRITICAL findings unresolved.',
        criticalFindings: ['auth bypass', 'XSS'],
        majorFindings: ['stale dep'],
        createdAt: '2026-05-15T01:00:00.000Z',
      },
    });

    const list = listInboxForRecipient(adapter, '@user');
    expect(list).toHaveLength(1);
    const row = list[0]!;
    expect(row.kind).toBe('action_required');
    expect(row.sourceType).toBe('gate-verdict');
    expect(row.sourceId).toBe('entry-rej-1');
    expect(row.body).toContain('REJECTED');
    expect(row.body).toContain('2 CRITICAL, 1 MAJOR');
  });

  it('mirrors an APPROVED verdict as info', () => {
    bus.publish<GateVerdictCreatedPayload>({
      from: 'system',
      to: 'broadcast',
      topic: 'gate.verdict.created',
      category: 'quality',
      payload: {
        workspaceId: 'test',
        entryId: 'entry-ok-1',
        cycleId: 'cycle-v2.5',
        verdict: 'approved',
        rationale: 'Ship it.',
        criticalFindings: [],
        majorFindings: [],
        createdAt: '2026-05-15T01:00:00.000Z',
      },
    });

    const list = listInboxForRecipient(adapter, '@user');
    expect(list).toHaveLength(1);
    expect(list[0]?.kind).toBe('info');
  });

  it('is idempotent on replay — same entryId only produces one row', () => {
    const payload: GateVerdictCreatedPayload = {
      workspaceId: 'test',
      entryId: 'entry-dup-1',
      cycleId: 'cycle-replay',
      verdict: 'rejected',
      rationale: 'broken',
      criticalFindings: [],
      majorFindings: [],
      createdAt: '2026-05-15T01:00:00.000Z',
    };
    bus.publish<GateVerdictCreatedPayload>({
      from: 'system', to: 'broadcast', topic: 'gate.verdict.created', category: 'quality', payload,
    });
    bus.publish<GateVerdictCreatedPayload>({
      from: 'system', to: 'broadcast', topic: 'gate.verdict.created', category: 'quality', payload,
    });
    expect(listInboxForRecipient(adapter, '@user')).toHaveLength(1);
  });
});

describe('InboxBridge — review.finding.created mirroring (Phase 2 / ADR 0004)', () => {
  it('mirrors a CRITICAL finding as action_required', () => {
    bus.publish<ReviewFindingCreatedPayload>({
      from: 'system',
      to: 'broadcast',
      topic: 'review.finding.created',
      category: 'quality',
      payload: {
        workspaceId: 'test',
        entryId: 'finding-crit-1',
        cycleId: 'cycle-v2.5',
        severity: 'CRITICAL',
        summary: 'SQL injection in /api/v5/foo',
        file: 'packages/server/src/routes/v5/foo.ts',
        line: 42,
        fixSuggestion: 'use a prepared statement',
        createdAt: '2026-05-15T01:00:00.000Z',
      },
    });
    const list = listInboxForRecipient(adapter, '@user');
    expect(list).toHaveLength(1);
    const row = list[0]!;
    expect(row.kind).toBe('action_required');
    expect(row.sourceType).toBe('review-finding');
    expect(row.sourceId).toBe('finding-crit-1');
    expect(row.body).toContain('[CRITICAL]');
    expect(row.body).toContain('foo.ts');
    expect(row.body).toContain('Suggested fix');
  });

  it('mirrors a MAJOR finding as warning', () => {
    bus.publish<ReviewFindingCreatedPayload>({
      from: 'system',
      to: 'broadcast',
      topic: 'review.finding.created',
      category: 'quality',
      payload: {
        workspaceId: 'test',
        entryId: 'finding-major-1',
        cycleId: 'cycle-v2.5',
        severity: 'MAJOR',
        summary: 'unused export risks coupling',
        file: null,
        line: null,
        fixSuggestion: null,
        createdAt: '2026-05-15T01:00:00.000Z',
      },
    });
    const list = listInboxForRecipient(adapter, '@user');
    expect(list).toHaveLength(1);
    expect(list[0]?.kind).toBe('warning');
  });

  it('does not mirror non-CRITICAL/MAJOR findings (defensive guard)', () => {
    // The publisher should never emit minor severities, but the bridge
    // must reject them in case a future producer drifts.
    bus.publish({
      from: 'system',
      to: 'broadcast',
      topic: 'review.finding.created',
      category: 'quality',
      payload: {
        workspaceId: 'test',
        entryId: 'finding-x',
        cycleId: 'c',
        severity: 'MINOR' as unknown as 'CRITICAL',
        summary: 's',
        file: null,
        line: null,
        fixSuggestion: null,
        createdAt: '2026-05-15T01:00:00.000Z',
      } as ReviewFindingCreatedPayload,
    });
    expect(listInboxForRecipient(adapter, '@user')).toHaveLength(0);
  });

  it('is idempotent on replay', () => {
    const payload: ReviewFindingCreatedPayload = {
      workspaceId: 'test',
      entryId: 'finding-dup-1',
      cycleId: 'cycle-replay',
      severity: 'CRITICAL',
      summary: 'replayed finding',
      file: null,
      line: null,
      fixSuggestion: null,
      createdAt: '2026-05-15T01:00:00.000Z',
    };
    bus.publish<ReviewFindingCreatedPayload>({
      from: 'system', to: 'broadcast', topic: 'review.finding.created', category: 'quality', payload,
    });
    bus.publish<ReviewFindingCreatedPayload>({
      from: 'system', to: 'broadcast', topic: 'review.finding.created', category: 'quality', payload,
    });
    expect(listInboxForRecipient(adapter, '@user')).toHaveLength(1);
  });
});
