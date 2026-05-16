/**
 * InboxBridge — subscribes to `MessageBusV2` topics and mirrors selected
 * events into the central inbox for `@user`.
 *
 * v1 wires a single topic — `cost.budget.warning` — per the spec's "v1 minimum
 * viable" section. v2 will add gate verdicts and review findings; the wiring
 * point is `topics` below.
 *
 * Lifecycle: instantiate once at server boot, call `attach()` to subscribe,
 * and call `detach()` on shutdown to release subscriptions cleanly. Errors
 * inside the handler are swallowed and logged — a failure to mirror must
 * never crash the publisher.
 */

import type { WorkspaceAdapter } from '@agentforge/db';
import type { MessageBusV2 } from '../message-bus/message-bus.js';
import type {
  MessageEnvelopeV2,
  MessageTopic,
  CostBudgetWarningPayload,
} from '../message-bus/types.js';
import { sendInboxMessage } from './inbox.js';
import type { InboxMessage } from './types.js';

export interface InboxBridgeOptions {
  bus: MessageBusV2;
  adapter: WorkspaceAdapter;
  /**
   * Optional logger. Defaults to a no-op so tests stay quiet. The bridge
   * uses it only for error paths; the success path is intentionally silent.
   */
  log?: (level: 'info' | 'error', message: string, meta?: Record<string, unknown>) => void;
}

export class InboxBridge {
  private readonly bus: MessageBusV2;
  private readonly adapter: WorkspaceAdapter;
  private readonly log: (level: 'info' | 'error', message: string, meta?: Record<string, unknown>) => void;
  private readonly unsubscribers: Array<() => void> = [];
  private attached = false;

  constructor(opts: InboxBridgeOptions) {
    this.bus = opts.bus;
    this.adapter = opts.adapter;
    this.log = opts.log ?? (() => {});
  }

  /** Subscribe to the v1 bridge topics. Idempotent. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;

    const unsub = this.bus.subscribe<CostBudgetWarningPayload>(
      'cost.budget.warning' as MessageTopic,
      (envelope) => {
        this.handleBudgetWarning(envelope);
      },
    );
    this.unsubscribers.push(unsub);
  }

  /** Drop subscriptions. Safe to call when not attached. */
  detach(): void {
    while (this.unsubscribers.length > 0) {
      const fn = this.unsubscribers.pop();
      try {
        fn?.();
      } catch {
        // best-effort
      }
    }
    this.attached = false;
  }

  /** Synchronous handler used internally; exposed for unit tests. */
  handleBudgetWarning(envelope: MessageEnvelopeV2<CostBudgetWarningPayload>): InboxMessage | undefined {
    try {
      const p = envelope.payload;
      const pctText = Number.isFinite(p.percentUsed) ? `${Math.round(p.percentUsed * 100) / 100}%` : 'unknown';
      const agentText = p.agentId ? ` for agent \`${p.agentId}\`` : '';
      const body =
        `Budget usage ${pctText} of $${p.budgetUsd.toFixed(2)}${agentText}. ` +
        `Spent so far: $${p.spentUsd.toFixed(4)} (workspace \`${p.workspaceId}\`).`;
      const result = sendInboxMessage(this.adapter, {
        body,
        kind: 'warning',
        sourceId: envelope.correlationId ?? envelope.id,
        sourceType: 'cost-warning',
        recipients: ['@user'],
      });
      return result.message;
    } catch (err) {
      this.log('error', 'InboxBridge: failed to mirror cost.budget.warning', {
        error: err instanceof Error ? err.message : String(err),
        envelopeId: envelope.id,
      });
      return undefined;
    }
  }
}
