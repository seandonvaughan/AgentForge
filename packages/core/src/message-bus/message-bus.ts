import { generateId, nowIso } from '@agentforge/shared';
import type { AgentId, WorkspaceId } from '@agentforge/shared';
import type { MessageEnvelopeV2, MessageTopic, MessageCategory, MessagePriority } from './types.js';

export type MessageHandler<T = unknown> = (envelope: MessageEnvelopeV2<T>) => void | Promise<void>;
export type TopicPattern = MessageTopic | `${string}.*`; // supports wildcard e.g. 'agent.task.*'

export interface MessageBusOptions {
  workspaceId?: WorkspaceId;
  maxHistorySize?: number;
}

export interface BusStats {
  totalPublished: number;
  historySize: number;
  subscriberCount: number;
}

export interface PublishParams<T> {
  from: AgentId | 'system' | 'user';
  to: AgentId | 'broadcast' | 'system';
  topic: MessageTopic;
  category: MessageCategory;
  payload: T;
  priority?: MessagePriority;
  correlationId?: string;
  sessionId?: string;
  ttlMs?: number;
}

export class MessageBusV2 {
  private readonly workspaceId: WorkspaceId;
  private readonly handlers = new Map<string, Set<MessageHandler>>();
  private readonly history: MessageEnvelopeV2[] = [];
  private readonly maxHistorySize: number;
  private totalPublished = 0;

  constructor(options: MessageBusOptions = {}) {
    this.workspaceId = options.workspaceId ?? 'default';
    this.maxHistorySize = options.maxHistorySize ?? 1000;
  }

  /**
   * Publish a message to the bus. Returns the fully formed envelope.
   * Handlers are called asynchronously (fire-and-forget).
   */
  publish<T>(params: PublishParams<T>): MessageEnvelopeV2<T> {
    const envelope: MessageEnvelopeV2<T> = {
      id: generateId(),
      version: '2.0',
      timestamp: nowIso(),
      workspaceId: this.workspaceId,
      from: params.from,
      to: params.to,
      topic: params.topic,
      category: params.category,
      priority: params.priority ?? 'normal',
      payload: params.payload,
      ...(params.correlationId ? { correlationId: params.correlationId } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.ttlMs !== undefined ? { ttlMs: params.ttlMs } : {}),
    };

    // Store in history with ring-buffer semantics
    this.history.push(envelope);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
    this.totalPublished++;

    // Dispatch to all matching handlers
    this.dispatch(envelope);

    return envelope;
  }

  /**
   * Subscribe to a specific topic or wildcard pattern (e.g. 'agent.task.*').
   * Returns an unsubscribe function — call it to stop receiving messages.
   */
  subscribe<T = unknown>(pattern: TopicPattern, handler: MessageHandler<T>): () => void {
    const key = pattern;
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
    }
    this.handlers.get(key)!.add(handler as MessageHandler);

    return () => {
      this.handlers.get(key)?.delete(handler as MessageHandler);
      // Clean up empty sets to prevent memory leaks
      if (this.handlers.get(key)?.size === 0) {
        this.handlers.delete(key);
      }
    };
  }

  /**
   * Subscribe to all messages (catch-all). Equivalent to 'subscribe("*", handler)'.
   */
  subscribeAll<T = unknown>(handler: MessageHandler<T>): () => void {
    return this.subscribe('*.*' as TopicPattern, handler);
  }

  /**
   * Wait for the next message matching the given topic/pattern.
   * Resolves with the envelope or rejects after timeoutMs (default: 30 000 ms).
   */
  once<T = unknown>(pattern: TopicPattern, timeoutMs = 30_000): Promise<MessageEnvelopeV2<T>> {
    return new Promise((resolve, reject) => {
      let unsubscribe: (() => void) | undefined;
      const timer = setTimeout(() => {
        unsubscribe?.();
        reject(new Error(`MessageBusV2.once timeout after ${timeoutMs}ms waiting for "${pattern}"`));
      }, timeoutMs);

      unsubscribe = this.subscribe<T>(pattern, (envelope) => {
        clearTimeout(timer);
        unsubscribe?.();
        resolve(envelope);
      });
    });
  }

  /**
   * Replay stored history to a new subscriber (useful for late joiners).
   * Optionally filter by topic.
   */
  replay(handler: MessageHandler, topic?: MessageTopic): void {
    const messages = topic
      ? this.history.filter((m) => m.topic === topic)
      : this.history.slice();

    for (const envelope of messages) {
      void handler(envelope);
    }
  }

  /**
   * Get recent message history. Optionally filter by topic.
   */
  getHistory(limit = 100, topic?: MessageTopic): MessageEnvelopeV2[] {
    let messages = this.history.slice(-limit);
    if (topic) {
      messages = messages.filter((m) => m.topic === topic);
    }
    return messages;
  }

  /**
   * Get operational stats for the bus.
   */
  getStats(): BusStats {
    let subscriberCount = 0;
    for (const set of this.handlers.values()) {
      subscriberCount += set.size;
    }
    return {
      totalPublished: this.totalPublished,
      historySize: this.history.length,
      subscriberCount,
    };
  }

  /**
   * Drain all history and remove all subscribers. Useful for test teardown.
   */
  clear(): void {
    this.history.length = 0;
    this.handlers.clear();
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private dispatch(envelope: MessageEnvelopeV2): void {
    // 1. Exact topic match
    const exactHandlers = this.handlers.get(envelope.topic);
    if (exactHandlers) {
      for (const handler of exactHandlers) {
        void handler(envelope);
      }
    }

    // 2. Wildcard match: 'agent.task.*' matches 'agent.task.completed', etc.
    for (const [pattern, handlers] of this.handlers) {
      if (pattern === envelope.topic) continue; // already dispatched above

      if (pattern.endsWith('.*')) {
        const prefix = pattern.slice(0, -2); // strip '.*'
        if (envelope.topic.startsWith(prefix + '.') || envelope.topic === prefix) {
          for (const handler of handlers) {
            void handler(envelope);
          }
        }
      } else if (pattern === '*.*' || pattern === '*') {
        // Catch-all — subscribeAll() uses '*.*'
        for (const handler of handlers) {
          void handler(envelope);
        }
      }
    }
  }
}
