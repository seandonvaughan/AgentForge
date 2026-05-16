/**
 * InboxBridge — subscribes to `MessageBusV2` topics and mirrors selected
 * events into the central inbox for `@user`.
 *
 * Topics handled:
 *   - `cost.budget.warning` (v1)
 *   - `gate.verdict.created` (Phase 2, per ADR 0004) — kind = 'action_required'
 *     when verdict is rejected, 'info' otherwise. The memory entry id flows
 *     through as the inbox `sourceId` so clicking a verdict in /inbox jumps
 *     back to the canonical JSONL row.
 *   - `review.finding.created` (Phase 2, per ADR 0004) — kind = 'action_required'
 *     for CRITICAL, 'warning' for MAJOR. Minor findings are NOT mirrored
 *     (keeps inbox signal-to-noise high — spec §6.4).
 *
 * Idempotency: every gate/finding mirror is keyed by `(source_type, source_id)`.
 * The bridge calls `findInboxMessageBySource()` first; if a row already exists,
 * the mirror is skipped. This handles bus replay (subscriber-late-joiner)
 * cleanly — multiple deliveries of the same envelope only ever produce one
 * inbox row.
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
  GateVerdictCreatedPayload,
  ReviewFindingCreatedPayload,
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

const GATE_SOURCE_TYPE = 'gate-verdict';
const REVIEW_SOURCE_TYPE = 'review-finding';

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

  /** Subscribe to the bridge topics. Idempotent. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;

    this.unsubscribers.push(
      this.bus.subscribe<CostBudgetWarningPayload>(
        'cost.budget.warning' as MessageTopic,
        (envelope) => { this.handleBudgetWarning(envelope); },
      ),
      this.bus.subscribe<GateVerdictCreatedPayload>(
        'gate.verdict.created' as MessageTopic,
        (envelope) => { this.handleGateVerdict(envelope); },
      ),
      this.bus.subscribe<ReviewFindingCreatedPayload>(
        'review.finding.created' as MessageTopic,
        (envelope) => { this.handleReviewFinding(envelope); },
      ),
    );
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
      const result = sendInboxMessage(
        this.adapter,
        {
          body,
          kind: 'warning',
          sourceId: envelope.correlationId ?? envelope.id,
          sourceType: 'cost-warning',
          recipients: ['@user'],
        },
        { bus: this.bus },
      );
      return result.message;
    } catch (err) {
      this.log('error', 'InboxBridge: failed to mirror cost.budget.warning', {
        error: err instanceof Error ? err.message : String(err),
        envelopeId: envelope.id,
      });
      return undefined;
    }
  }

  /**
   * Mirror a `gate.verdict.created` envelope into the @user inbox.
   * Idempotent — replay does not produce duplicates because we key on
   * `(source_type, source_id) = ('gate-verdict', entryId)`.
   */
  handleGateVerdict(envelope: MessageEnvelopeV2<GateVerdictCreatedPayload>): InboxMessage | undefined {
    try {
      const p = envelope.payload;
      const existing = this.adapter.findInboxMessageBySource(GATE_SOURCE_TYPE, p.entryId);
      if (existing) return undefined;

      const kind = p.verdict === 'rejected' ? 'action_required' : 'info';
      const findingsLine =
        p.criticalFindings.length > 0
          ? ` (${p.criticalFindings.length} CRITICAL, ${p.majorFindings.length} MAJOR)`
          : p.majorFindings.length > 0
            ? ` (${p.majorFindings.length} MAJOR)`
            : '';
      const body =
        `Gate verdict for cycle \`${p.cycleId}\`: **${p.verdict.toUpperCase()}**${findingsLine}.\n\n` +
        p.rationale;
      const result = sendInboxMessage(
        this.adapter,
        {
          body,
          kind,
          sourceId: p.entryId,
          sourceType: GATE_SOURCE_TYPE,
          recipients: ['@user'],
        },
        { bus: this.bus },
      );
      return result.message;
    } catch (err) {
      this.log('error', 'InboxBridge: failed to mirror gate.verdict.created', {
        error: err instanceof Error ? err.message : String(err),
        envelopeId: envelope.id,
      });
      return undefined;
    }
  }

  /**
   * Mirror a `review.finding.created` envelope into the @user inbox. Only
   * CRITICAL + MAJOR severities reach this handler (per spec §6.4 — minor
   * findings stay in JSONL only).
   */
  handleReviewFinding(envelope: MessageEnvelopeV2<ReviewFindingCreatedPayload>): InboxMessage | undefined {
    try {
      const p = envelope.payload;
      if (p.severity !== 'CRITICAL' && p.severity !== 'MAJOR') return undefined;
      const existing = this.adapter.findInboxMessageBySource(REVIEW_SOURCE_TYPE, p.entryId);
      if (existing) return undefined;

      const kind = p.severity === 'CRITICAL' ? 'action_required' : 'warning';
      const location = p.file ? ` (\`${p.file}\`${p.line ? `:${p.line}` : ''})` : '';
      const fix = p.fixSuggestion ? `\n\n_Suggested fix:_ ${p.fixSuggestion}` : '';
      const body = `[${p.severity}]${location} ${p.summary}${fix}`;
      const result = sendInboxMessage(
        this.adapter,
        {
          body,
          kind,
          sourceId: p.entryId,
          sourceType: REVIEW_SOURCE_TYPE,
          recipients: ['@user'],
        },
        { bus: this.bus },
      );
      return result.message;
    } catch (err) {
      this.log('error', 'InboxBridge: failed to mirror review.finding.created', {
        error: err instanceof Error ? err.message : String(err),
        envelopeId: envelope.id,
      });
      return undefined;
    }
  }
}
