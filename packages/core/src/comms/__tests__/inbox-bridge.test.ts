/**
 * Tests for the InboxBridge — subscribes to `cost.budget.warning` and writes
 * the corresponding row into the @user inbox.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';
import { MessageBusV2 } from '../../message-bus/index.js';
import type { CostBudgetWarningPayload } from '../../message-bus/types.js';
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
