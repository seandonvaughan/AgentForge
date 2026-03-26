/**
 * V4MessageBus — Sprint 2.1a
 *
 * Typed pub/sub engine built on MessageEnvelope<TPayload>. Replaces the
 * ad-hoc string-based v3.2 TeamModeBus with a topic-registry approach:
 *
 *   - Topics are registered with a string name and optional payload validator
 *   - Subscribers bind to exact topics or wildcard prefixes ("review.*")
 *   - All messages are enveloped with the v4 Integration API format
 *   - Priority queue: urgent messages bypass queue and deliver synchronously
 *   - Global listeners receive every delivered message (for monitoring)
 *   - Full history retained in-memory; cleared on explicit reset
 *
 * This bus is intentionally in-process. Network transport (for multi-process
 * agent scenarios) is a Phase 3+ concern.
 */

import { randomUUID } from "node:crypto";
import type {
  MessageEnvelope,
  MessageCategory,
  V4MessagePriority,
  DisplayTierHint,
} from "../types/v4-api.js";

export type EnvelopeHandler<TPayload = unknown> = (
  envelope: MessageEnvelope<TPayload>
) => void;

interface TopicRegistration {
  topic: string;
  description: string;
  validator?: (payload: unknown) => boolean;
}

interface QueuedEnvelope {
  envelope: MessageEnvelope;
  priorityRank: number;
}

const PRIORITY_RANK: Record<V4MessagePriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export interface PublishOptions<TPayload> {
  from: string;
  to: string;
  topic: string;
  category: MessageCategory;
  payload: TPayload;
  priority?: V4MessagePriority;
  replyTo?: string;
  conversationId?: string;
  ttl?: string;
  displayTierHint?: DisplayTierHint;
  metadata?: Record<string, unknown>;
}

export class V4MessageBus {
  private topics = new Map<string, TopicRegistration>();
  /** Exact topic → handlers */
  private subscribers = new Map<string, Array<EnvelopeHandler>>();
  /** Wildcard prefix → handlers (e.g. "review" matches "review.lifecycle.assigned") */
  private wildcardSubscribers = new Map<string, Array<EnvelopeHandler>>();
  private globalListeners: Array<EnvelopeHandler> = [];
  private queue: QueuedEnvelope[] = [];
  private history: MessageEnvelope[] = [];
  private draining = false;

  // ---------------------------------------------------------------------------
  // Topic registry
  // ---------------------------------------------------------------------------

  registerTopic(registration: TopicRegistration): void {
    this.topics.set(registration.topic, registration);
  }

  hasTopic(topic: string): boolean {
    return this.topics.has(topic);
  }

  listTopics(): string[] {
    return Array.from(this.topics.keys()).sort();
  }

  // ---------------------------------------------------------------------------
  // Publish
  // ---------------------------------------------------------------------------

  publish<TPayload>(options: PublishOptions<TPayload>): MessageEnvelope<TPayload> {
    const reg = this.findTopic(options.topic);
    if (reg?.validator && !reg.validator(options.payload)) {
      throw new Error(`Payload validation failed for topic "${options.topic}"`);
    }

    const priority = options.priority ?? "normal";
    const envelope: MessageEnvelope<TPayload> = {
      id: randomUUID(),
      version: "4.0",
      timestamp: new Date().toISOString(),
      from: options.from,
      to: options.to,
      topic: options.topic,
      category: options.category,
      priority,
      payload: options.payload,
      replyTo: options.replyTo,
      conversationId: options.conversationId,
      ttl: options.ttl,
      displayTierHint: options.displayTierHint,
      metadata: options.metadata,
    };

    this.history.push(envelope as MessageEnvelope);
    for (const listener of this.globalListeners) {
      listener(envelope as MessageEnvelope);
    }

    if (priority === "urgent") {
      this.deliver(envelope as MessageEnvelope);
    } else {
      this.queue.push({
        envelope: envelope as MessageEnvelope,
        priorityRank: PRIORITY_RANK[priority],
      });
      if (!this.draining) this.scheduleFlush();
    }

    return envelope;
  }

  // ---------------------------------------------------------------------------
  // Subscribe
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to an exact topic.
   * Returns an unsubscribe function.
   */
  subscribe<TPayload>(
    topic: string,
    handler: EnvelopeHandler<TPayload>
  ): () => void {
    const handlers = this.subscribers.get(topic) ?? [];
    handlers.push(handler as EnvelopeHandler);
    this.subscribers.set(topic, handlers);
    return () => this.unsubscribeTopic(topic, handler as EnvelopeHandler);
  }

  /**
   * Subscribe to all topics starting with a prefix (e.g. "review" matches
   * "review.lifecycle.assigned", "review.lifecycle.approved").
   * Returns an unsubscribe function.
   */
  subscribeWildcard<TPayload>(
    prefix: string,
    handler: EnvelopeHandler<TPayload>
  ): () => void {
    const handlers = this.wildcardSubscribers.get(prefix) ?? [];
    handlers.push(handler as EnvelopeHandler);
    this.wildcardSubscribers.set(prefix, handlers);
    return () => this.unsubscribeWildcard(prefix, handler as EnvelopeHandler);
  }

  /** Receive every delivered message — for monitoring / feed-renderer. */
  onAnyMessage(handler: EnvelopeHandler): () => void {
    this.globalListeners.push(handler);
    return () => {
      this.globalListeners = this.globalListeners.filter((h) => h !== handler);
    };
  }

  // ---------------------------------------------------------------------------
  // Queue management
  // ---------------------------------------------------------------------------

  /** Deliver all queued messages in priority order. */
  drain(): void {
    this.draining = true;
    this.queue.sort((a, b) => a.priorityRank - b.priorityRank);
    const toProcess = [...this.queue];
    this.queue = [];
    for (const { envelope } of toProcess) {
      if (this.isExpired(envelope)) continue;
      this.deliver(envelope);
    }
    this.draining = false;
  }

  pendingCount(): number {
    return this.queue.length;
  }

  // ---------------------------------------------------------------------------
  // History / inspection
  // ---------------------------------------------------------------------------

  getHistory(): MessageEnvelope[] {
    return [...this.history];
  }

  getHistoryForTopic(topic: string): MessageEnvelope[] {
    return this.history.filter((e) => e.topic === topic);
  }

  getHistoryForAddress(address: string): MessageEnvelope[] {
    return this.history.filter((e) => e.from === address || e.to === address);
  }

  clearHistory(): void {
    this.history = [];
  }

  reset(): void {
    this.queue = [];
    this.history = [];
    this.subscribers.clear();
    this.wildcardSubscribers.clear();
    this.globalListeners = [];
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private deliver(envelope: MessageEnvelope): void {
    const exact = this.subscribers.get(envelope.topic) ?? [];
    for (const handler of exact) handler(envelope);

    for (const [prefix, handlers] of this.wildcardSubscribers) {
      if (envelope.topic.startsWith(prefix)) {
        for (const handler of handlers) handler(envelope);
      }
    }
  }

  private scheduleFlush(): void {
    // In-process synchronous flush (no I/O, no event loop needed)
    // Callers that need async delivery should call drain() explicitly.
    // This is intentionally a no-op — drain() is called explicitly.
  }

  private isExpired(envelope: MessageEnvelope): boolean {
    if (!envelope.ttl) return false;
    return new Date(envelope.ttl).getTime() < Date.now();
  }

  private findTopic(topic: string): TopicRegistration | undefined {
    // Exact match first; then wildcard (e.g. "review.*" → "review")
    if (this.topics.has(topic)) return this.topics.get(topic);
    for (const [key, reg] of this.topics) {
      if (key.endsWith(".*") && topic.startsWith(key.slice(0, -2))) return reg;
    }
    return undefined;
  }

  private unsubscribeTopic(topic: string, handler: EnvelopeHandler): void {
    const handlers = this.subscribers.get(topic);
    if (handlers) {
      this.subscribers.set(topic, handlers.filter((h) => h !== handler));
    }
  }

  private unsubscribeWildcard(prefix: string, handler: EnvelopeHandler): void {
    const handlers = this.wildcardSubscribers.get(prefix);
    if (handlers) {
      this.wildcardSubscribers.set(prefix, handlers.filter((h) => h !== handler));
    }
  }
}

// ---------------------------------------------------------------------------
// Standard v4 topic registrations (pre-built set for all pillars)
// ---------------------------------------------------------------------------

export function registerStandardTopics(bus: V4MessageBus): void {
  const topics: TopicRegistration[] = [
    { topic: "agent.task.assign",           description: "Task assignment from supervisor to agent" },
    { topic: "agent.task.result",           description: "Task completion report from agent" },
    { topic: "agent.status.update",         description: "Agent state change notification" },
    { topic: "review.lifecycle.assigned",   description: "Review assigned to reviewer" },
    { topic: "review.lifecycle.responded",  description: "Reviewer submitted feedback" },
    { topic: "review.lifecycle.resolved",   description: "Author acknowledged feedback" },
    { topic: "review.lifecycle.approved",   description: "Final approval granted" },
    { topic: "meeting.coordination.requested", description: "Meeting requested by agent" },
    { topic: "meeting.coordination.scheduled", description: "Meeting confirmed by coordinator" },
    { topic: "meeting.coordination.completed", description: "Meeting concluded" },
    { topic: "meeting.coordination.queued",    description: "Meeting queued (at 3-meeting cap)" },
    { topic: "memory.query",                description: "Knowledge base query" },
    { topic: "memory.result",               description: "Knowledge base query result" },
    { topic: "reforge.propose",             description: "REFORGE proposal from improvement-analyst" },
    { topic: "reforge.approve",             description: "REFORGE approval decision" },
    { topic: "reforge.apply",               description: "REFORGE application result" },
    { topic: "escalation.raised",           description: "Issue escalated to supervisor chain" },
    { topic: "escalation.resolved",         description: "Escalation resolved" },
  ];
  for (const t of topics) bus.registerTopic(t);
}
