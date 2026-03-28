/**
 * EventCollector — P0-3: EventBus → SQLite middleware
 *
 * Subscribes to V4MessageBus event topics and persists data to SQLite via
 * SqliteAdapter. Handles 8 event types covering sessions, feedback, costs,
 * task outcomes, and autonomy tier promotions/demotions.
 *
 * Error isolation: bad payloads log to stderr and are swallowed — they must
 * never crash the collector or the process.
 */

import { randomUUID } from 'node:crypto';
import type { V4MessageBus, EnvelopeHandler } from '../communication/v4-message-bus.js';
import type { SqliteAdapter } from '../db/sqlite-adapter.js';
import type { SseManager } from '../server/sse/sse-manager.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface EventCollectorOptions {
  bus: V4MessageBus;
  adapter: SqliteAdapter;
  /** Optional SSE manager — when provided, events are broadcast in real time after SQLite write. */
  sseManager?: SseManager;
}

// ---------------------------------------------------------------------------
// Payload shapes (loose — we validate at runtime and coerce)
// ---------------------------------------------------------------------------

interface SessionStartedPayload {
  sessionId?: string;
  agentId?: string;
  agentName?: string;
  model?: string;
  task?: string;
}

interface SessionCompletedPayload {
  sessionId?: string;
  response?: string;
  estimatedTokens?: number;
}

interface SessionFailedPayload {
  sessionId?: string;
  error?: string;
}

interface FeedbackSubmittedPayload {
  agentId?: string;
  taskId?: string;
  sprintId?: string;
  category?: string;
  message?: string;
  sessionId?: string;
  sentiment?: string;
}

interface TaskCompletedPayload {
  sessionId?: string;
  agentId?: string;
  task?: string;
  success?: boolean;
  qualityScore?: number;
  model?: string;
  durationMs?: number;
}

interface CostIncurredPayload {
  sessionId?: string;
  agentId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

interface AutonomyPromotionPayload {
  agentId?: string;
  previousTier?: number;
  newTier?: number;
  reason?: string;
}

interface CostAnomalyPayload {
  sessionId?: string;
  agentId: string;
  amount: number;
  threshold: number;
}

// ---------------------------------------------------------------------------
// EventCollector
// ---------------------------------------------------------------------------

export class EventCollector {
  private readonly unsubs: Array<() => void> = [];

  constructor(private readonly opts: EventCollectorOptions) {
    this.attachListeners();
  }

  private attachListeners(): void {
    const { bus, adapter, sseManager } = this.opts;

    // 1. session.started
    this.unsubs.push(
      bus.subscribe<SessionStartedPayload>('session.started', (envelope) => {
        try {
          const p = envelope.payload ?? {};
          const sessionId = p.sessionId;
          if (!sessionId) throw new Error('session.started: missing sessionId');
          adapter.insertSession({
            id: sessionId,
            agent_id: p.agentId ?? 'unknown',
            agent_name: p.agentName ?? null,
            model: p.model ?? null,
            task: p.task ?? '',
            response: null,
            status: 'running',
            started_at: envelope.timestamp ?? new Date().toISOString(),
            completed_at: null,
            estimated_tokens: null,
            autonomy_tier: null,
            resume_count: 0,
            parent_session_id: null,
            delegation_depth: 0,
          });
          sseManager?.broadcast('session.started', envelope.payload);
        } catch (err) {
          process.stderr.write(`[EventCollector] session.started error: ${String(err)}\n`);
        }
      })
    );

    // 2. session.completed
    this.unsubs.push(
      bus.subscribe<SessionCompletedPayload>('session.completed', (envelope) => {
        try {
          const p = envelope.payload ?? {};
          const sessionId = p.sessionId;
          if (!sessionId) throw new Error('session.completed: missing sessionId');
          adapter.updateSession(sessionId, {
            status: 'completed',
            completed_at: envelope.timestamp ?? new Date().toISOString(),
            response: p.response ?? null,
            estimated_tokens: p.estimatedTokens ?? null,
          });
          sseManager?.broadcast('session.completed', envelope.payload);
        } catch (err) {
          process.stderr.write(`[EventCollector] session.completed error: ${String(err)}\n`);
        }
      })
    );

    // 3. session.failed
    this.unsubs.push(
      bus.subscribe<SessionFailedPayload>('session.failed', (envelope) => {
        try {
          const p = envelope.payload ?? {};
          const sessionId = p.sessionId;
          if (!sessionId) throw new Error('session.failed: missing sessionId');
          adapter.updateSession(sessionId, {
            status: 'failed',
            completed_at: envelope.timestamp ?? new Date().toISOString(),
          });
          sseManager?.broadcast('session.failed', envelope.payload);
        } catch (err) {
          process.stderr.write(`[EventCollector] session.failed error: ${String(err)}\n`);
        }
      })
    );

    // 4. feedback.submitted
    this.unsubs.push(
      bus.subscribe<FeedbackSubmittedPayload>('feedback.submitted', (envelope) => {
        try {
          const p = envelope.payload ?? {};
          if (!p.agentId) throw new Error('feedback.submitted: missing agentId');
          if (!p.message) throw new Error('feedback.submitted: missing message');
          adapter.insertFeedback({
            id: randomUUID(),
            agent_id: p.agentId,
            session_id: p.sessionId ?? null,
            category: p.category ?? p.sprintId ?? 'general',
            message: p.message,
            sentiment: p.sentiment ?? null,
            created_at: envelope.timestamp ?? new Date().toISOString(),
          });
          sseManager?.broadcast('feedback.submitted', envelope.payload);
        } catch (err) {
          process.stderr.write(`[EventCollector] feedback.submitted error: ${String(err)}\n`);
        }
      })
    );

    // 5. task.completed
    this.unsubs.push(
      bus.subscribe<TaskCompletedPayload>('task.completed', (envelope) => {
        try {
          const p = envelope.payload ?? {};
          if (!p.sessionId) throw new Error('task.completed: missing sessionId');
          if (!p.agentId) throw new Error('task.completed: missing agentId');
          adapter.insertTaskOutcome({
            id: randomUUID(),
            session_id: p.sessionId,
            agent_id: p.agentId,
            task: p.task ?? '',
            success: p.success ? 1 : 0,
            quality_score: p.qualityScore ?? null,
            model: p.model ?? null,
            duration_ms: p.durationMs ?? null,
            created_at: envelope.timestamp ?? new Date().toISOString(),
          });
          sseManager?.broadcast('task.completed', envelope.payload);
        } catch (err) {
          process.stderr.write(`[EventCollector] task.completed error: ${String(err)}\n`);
        }
      })
    );

    // 6. cost.incurred
    this.unsubs.push(
      bus.subscribe<CostIncurredPayload>('cost.incurred', (envelope) => {
        try {
          const p = envelope.payload ?? {};
          if (!p.agentId) throw new Error('cost.incurred: missing agentId');
          if (!p.model) throw new Error('cost.incurred: missing model');
          adapter.insertCost({
            id: randomUUID(),
            session_id: p.sessionId ?? null,
            agent_id: p.agentId,
            model: p.model,
            input_tokens: p.inputTokens ?? 0,
            output_tokens: p.outputTokens ?? 0,
            cost_usd: p.costUsd ?? 0,
            created_at: envelope.timestamp ?? new Date().toISOString(),
          });
          sseManager?.broadcast('cost.incurred', envelope.payload);
        } catch (err) {
          process.stderr.write(`[EventCollector] cost.incurred error: ${String(err)}\n`);
        }
      })
    );

    // 7. autonomy.promoted / flywheel.autonomy.promoted
    const promotionHandler: EnvelopeHandler<AutonomyPromotionPayload> = (envelope) => {
      try {
        const p = envelope.payload ?? {};
        if (!p.agentId) throw new Error('autonomy promoted: missing agentId');
        adapter.insertPromotion({
          id: randomUUID(),
          agent_id: p.agentId,
          previous_tier: p.previousTier ?? 0,
          new_tier: p.newTier ?? 0,
          promoted: 1,
          demoted: 0,
          reason: p.reason ?? null,
          created_at: envelope.timestamp ?? new Date().toISOString(),
        });
        sseManager?.broadcast('autonomy.promoted', envelope.payload);
      } catch (err) {
        process.stderr.write(`[EventCollector] autonomy.promoted error: ${String(err)}\n`);
      }
    };
    this.unsubs.push(bus.subscribe<AutonomyPromotionPayload>('autonomy.promoted', promotionHandler));
    this.unsubs.push(bus.subscribe<AutonomyPromotionPayload>('flywheel.autonomy.promoted', promotionHandler));

    // 8. autonomy.demoted / flywheel.autonomy.demoted
    const demotionHandler: EnvelopeHandler<AutonomyPromotionPayload> = (envelope) => {
      try {
        const p = envelope.payload ?? {};
        if (!p.agentId) throw new Error('autonomy demoted: missing agentId');
        adapter.insertPromotion({
          id: randomUUID(),
          agent_id: p.agentId,
          previous_tier: p.previousTier ?? 0,
          new_tier: p.newTier ?? 0,
          promoted: 0,
          demoted: 1,
          reason: p.reason ?? null,
          created_at: envelope.timestamp ?? new Date().toISOString(),
        });
        sseManager?.broadcast('autonomy.demoted', envelope.payload);
      } catch (err) {
        process.stderr.write(`[EventCollector] autonomy.demoted error: ${String(err)}\n`);
      }
    };
    this.unsubs.push(bus.subscribe<AutonomyPromotionPayload>('autonomy.demoted', demotionHandler));
    this.unsubs.push(bus.subscribe<AutonomyPromotionPayload>('flywheel.autonomy.demoted', demotionHandler));

    // 9. cost.anomaly
    this.unsubs.push(
      bus.subscribe<CostAnomalyPayload>('cost.anomaly', (envelope) => {
        try {
          const payload = envelope.payload;
          if (this.opts.sseManager) {
            this.opts.sseManager.broadcast('anomaly-detected', {
              agentId: payload.agentId,
              amount: payload.amount,
              threshold: payload.threshold,
              timestamp: envelope.timestamp ?? new Date().toISOString(),
            });
          }
        } catch (err) {
          process.stderr.write(`[EventCollector] anomaly event error: ${String(err)}\n`);
        }
      })
    );
  }

  destroy(): void {
    this.unsubs.forEach((fn) => fn());
    this.unsubs.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEventCollector(opts: EventCollectorOptions): EventCollector {
  return new EventCollector(opts);
}
