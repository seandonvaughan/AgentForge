/**
 * MessageBus — Priority-aware event bus wrapping the v2 EventBus.
 *
 * Iron Law 1: EventBus is WRAPPED, not modified or replaced.
 *
 * Adds:
 *   - Priority queuing (urgent > high > normal > low)
 *   - Async handler registration with typed callbacks
 *   - Auto-rules for event → action dispatch
 *   - drain() to process queued events in priority order
 *
 * Zero new dependencies.
 */

import type { TeamEvent } from "../types/orchestration.js";
import type { MessagePriority } from "../types/message.js";
import type { AutoRule } from "../types/session.js";
import { EventBus } from "./event-bus.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Async callback invoked when a matching event is published. */
export type EventHandler = (event: TeamEvent) => Promise<void>;

/** Internal registration record for a handler. */
interface HandlerRegistration {
  id: string;
  eventTypes: string[];
  handler: EventHandler;
}

/** A queued event awaiting drain(). */
interface QueuedEvent {
  event: TeamEvent;
  priority: MessagePriority;
}

/** Resolved auto-rule with a concrete handler instead of a string action. */
export interface ResolvedAutoRule {
  id: string;
  onEvent: string;
  handler: EventHandler;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Numeric priority for sorting — lower number = higher priority. */
const PRIORITY_RANK: Record<MessagePriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

// ---------------------------------------------------------------------------
// MessageBus
// ---------------------------------------------------------------------------

export class MessageBus {
  private readonly eventBus: EventBus;
  private readonly handlers = new Map<string, HandlerRegistration>();
  private readonly autoRules: ResolvedAutoRule[] = [];
  private readonly queue: QueuedEvent[] = [];
  private eventsProcessed = 0;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  // =========================================================================
  // Handler registration
  // =========================================================================

  /**
   * Register an async handler for one or more event types.
   *
   * Also subscribes on the underlying EventBus for backward compatibility
   * with v2 components that publish directly to EventBus.
   */
  register(
    handlerId: string,
    eventTypes: string[],
    handler: EventHandler,
  ): void {
    this.handlers.set(handlerId, { id: handlerId, eventTypes, handler });
    this.eventBus.subscribe(handlerId, eventTypes);
  }

  /** Remove a handler by its ID. */
  unregister(handlerId: string): void {
    this.handlers.delete(handlerId);
    this.eventBus.unsubscribe(handlerId);
  }

  // =========================================================================
  // Publishing
  // =========================================================================

  /**
   * Publish an event with an optional priority.
   *
   * - Urgent events are processed immediately (handlers invoked inline).
   * - All other priorities are queued for batch processing via drain().
   * - Auto-rules fire for all priorities.
   * - The event is also published through the underlying EventBus for v2 compat.
   *
   * Returns the list of agent names notified by the underlying EventBus.
   */
  async publish(
    event: TeamEvent,
    priority: MessagePriority = "normal",
  ): Promise<string[]> {
    // Forward to v2 EventBus for backward compatibility
    const notified = this.eventBus.publish(event);

    // Urgent events process immediately; others queue for drain()
    if (priority === "urgent") {
      await this.processEvent(event);
    } else {
      this.queue.push({ event, priority });
    }

    // Fire auto-rules regardless of priority
    for (const rule of this.autoRules) {
      if (rule.onEvent === event.type) {
        await rule.handler(event);
      }
    }

    this.eventsProcessed++;
    return notified;
  }

  // =========================================================================
  // Auto-rules
  // =========================================================================

  /**
   * Add an auto-rule that fires a handler when a matching event type is published.
   *
   * For integration with AgentForgeSession, the session factory resolves
   * string-based AutoRule.dispatchAction into concrete handlers and registers
   * them here as ResolvedAutoRules.
   */
  addAutoRule(rule: ResolvedAutoRule): void {
    this.autoRules.push(rule);
  }

  /** Remove an auto-rule by its ID. */
  removeAutoRule(ruleId: string): void {
    const idx = this.autoRules.findIndex((r) => r.id === ruleId);
    if (idx !== -1) this.autoRules.splice(idx, 1);
  }

  /**
   * Convenience: add an auto-rule from a plain AutoRule definition,
   * providing the handler separately.
   */
  addAutoRuleFromDefinition(rule: AutoRule, handler: EventHandler): void {
    this.autoRules.push({
      id: rule.id,
      onEvent: rule.onEvent,
      handler,
    });
  }

  // =========================================================================
  // Queue management
  // =========================================================================

  /**
   * Process all queued events in priority order (urgent first, low last).
   *
   * Events at the same priority level are processed in FIFO order.
   * The queue is empty after drain() completes.
   */
  async drain(): Promise<void> {
    // Stable sort by priority rank
    this.queue.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      await this.processEvent(item.event);
    }
  }

  /** Number of events waiting in the queue. */
  getPendingCount(): number {
    return this.queue.length;
  }

  /** Total events published through this bus (including urgent). */
  getEventsProcessedCount(): number {
    return this.eventsProcessed;
  }

  // =========================================================================
  // Accessors (delegating to underlying EventBus)
  // =========================================================================

  /** Get the wrapped EventBus for direct v2-compatible operations. */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /** Get subscribers for an event type from the underlying EventBus. */
  getSubscribers(eventType: string): string[] {
    return this.eventBus.getSubscribers(eventType);
  }

  // =========================================================================
  // Private
  // =========================================================================

  /** Invoke all registered handlers whose eventTypes match this event. */
  private async processEvent(event: TeamEvent): Promise<void> {
    for (const [, reg] of this.handlers) {
      if (
        reg.eventTypes.includes(event.type) ||
        reg.eventTypes.includes("*")
      ) {
        await reg.handler(event);
      }
    }
  }
}
