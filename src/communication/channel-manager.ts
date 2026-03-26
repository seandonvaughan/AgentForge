/**
 * ChannelManager — Sprint 2.3a
 *
 * Async channel system for agent-to-agent communication. Channels are named
 * persistent message queues with subscriptions. Unlike direct bus messages,
 * channels are durable — messages remain until explicitly consumed.
 *
 * Use cases:
 *   - Agent inboxes (each agent has a named channel)
 *   - Broadcast channels (e.g. "announcements")
 *   - Async task queues (reviewer queue, researcher queue)
 */

import { randomUUID } from "node:crypto";
import type { MessageCategory, V4MessagePriority } from "../types/v4-api.js";

export interface ChannelMessage {
  messageId: string;
  channelId: string;
  from: string;
  subject: string;
  body: string;
  category: MessageCategory;
  priority: V4MessagePriority;
  timestamp: string;
  consumed: boolean;
  consumedAt?: string;
  consumedBy?: string;
  metadata?: Record<string, unknown>;
}

export interface Channel {
  channelId: string;
  name: string;
  description: string;
  ownerId: string;               // Agent that owns/manages this channel
  subscribers: string[];         // Agents subscribed to new-message notifications
  messageCount: number;
  unconsumedCount: number;
  createdAt: string;
}

type NewMessageListener = (message: ChannelMessage) => void;

export class ChannelManager {
  private channels = new Map<string, Channel>();
  private messages = new Map<string, ChannelMessage[]>(); // channelId → messages
  private listeners = new Map<string, NewMessageListener[]>(); // channelId → listeners

  // ---------------------------------------------------------------------------
  // Channel lifecycle
  // ---------------------------------------------------------------------------

  createChannel(
    channelId: string,
    name: string,
    description: string,
    ownerId: string
  ): Channel {
    if (this.channels.has(channelId)) {
      throw new Error(`Channel "${channelId}" already exists`);
    }
    const channel: Channel = {
      channelId,
      name,
      description,
      ownerId,
      subscribers: [ownerId],
      messageCount: 0,
      unconsumedCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.channels.set(channelId, channel);
    this.messages.set(channelId, []);
    return this.cloneChannel(channel);
  }

  getChannel(channelId: string): Channel | null {
    const ch = this.channels.get(channelId);
    return ch ? this.cloneChannel(ch) : null;
  }

  listChannels(): Channel[] {
    return Array.from(this.channels.values()).map((ch) => this.cloneChannel(ch));
  }

  deleteChannel(channelId: string): void {
    if (!this.channels.has(channelId)) {
      throw new Error(`Channel "${channelId}" not found`);
    }
    this.channels.delete(channelId);
    this.messages.delete(channelId);
    this.listeners.delete(channelId);
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  subscribe(channelId: string, agentId: string): void {
    const channel = this.requireChannel(channelId);
    if (!channel.subscribers.includes(agentId)) {
      const updated = { ...channel, subscribers: [...channel.subscribers, agentId] };
      this.channels.set(channelId, updated);
    }
  }

  unsubscribe(channelId: string, agentId: string): void {
    const channel = this.requireChannel(channelId);
    const updated = {
      ...channel,
      subscribers: channel.subscribers.filter((s) => s !== agentId),
    };
    this.channels.set(channelId, updated);
  }

  /** Register a real-time listener (called when a new message arrives). */
  onNewMessage(channelId: string, listener: NewMessageListener): () => void {
    const listeners = this.listeners.get(channelId) ?? [];
    listeners.push(listener);
    this.listeners.set(channelId, listeners);
    return () => {
      const updated = (this.listeners.get(channelId) ?? []).filter((l) => l !== listener);
      this.listeners.set(channelId, updated);
    };
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  /** Post a message to a channel. Notifies real-time listeners. */
  post(
    channelId: string,
    from: string,
    subject: string,
    body: string,
    options?: {
      category?: MessageCategory;
      priority?: V4MessagePriority;
      metadata?: Record<string, unknown>;
    }
  ): ChannelMessage {
    const channel = this.requireChannel(channelId);
    const message: ChannelMessage = {
      messageId: randomUUID(),
      channelId,
      from,
      subject,
      body,
      category: options?.category ?? "status",
      priority: options?.priority ?? "normal",
      timestamp: new Date().toISOString(),
      consumed: false,
      metadata: options?.metadata,
    };
    const msgs = this.messages.get(channelId) ?? [];
    msgs.push(message);
    this.messages.set(channelId, msgs);

    // Update channel stats
    this.channels.set(channelId, {
      ...channel,
      messageCount: channel.messageCount + 1,
      unconsumedCount: channel.unconsumedCount + 1,
    });

    // Notify listeners
    for (const listener of this.listeners.get(channelId) ?? []) {
      listener({ ...message });
    }

    return { ...message };
  }

  /** Read (but don't consume) messages from a channel. */
  read(channelId: string, limit = 50): ChannelMessage[] {
    this.requireChannel(channelId);
    const msgs = this.messages.get(channelId) ?? [];
    return msgs.slice(-limit).map((m) => ({ ...m }));
  }

  /** Read only unconsumed messages. */
  readUnconsumed(channelId: string): ChannelMessage[] {
    this.requireChannel(channelId);
    return (this.messages.get(channelId) ?? [])
      .filter((m) => !m.consumed)
      .map((m) => ({ ...m }));
  }

  /** Mark a message as consumed by an agent. */
  consume(channelId: string, messageId: string, byAgentId: string): void {
    const channel = this.requireChannel(channelId);
    const msgs = this.messages.get(channelId) ?? [];
    const idx = msgs.findIndex((m) => m.messageId === messageId);
    if (idx === -1) throw new Error(`Message "${messageId}" not found in channel "${channelId}"`);
    if (msgs[idx].consumed) return; // idempotent
    msgs[idx] = {
      ...msgs[idx],
      consumed: true,
      consumedAt: new Date().toISOString(),
      consumedBy: byAgentId,
    };
    this.messages.set(channelId, msgs);
    this.channels.set(channelId, {
      ...channel,
      unconsumedCount: Math.max(0, channel.unconsumedCount - 1),
    });
  }

  /** Consume all unconsumed messages in a channel (inbox drain). */
  consumeAll(channelId: string, byAgentId: string): ChannelMessage[] {
    const unconsumed = this.readUnconsumed(channelId);
    for (const msg of unconsumed) {
      this.consume(channelId, msg.messageId, byAgentId);
    }
    return unconsumed;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private requireChannel(channelId: string): Channel {
    const ch = this.channels.get(channelId);
    if (!ch) throw new Error(`Channel "${channelId}" not found`);
    return ch;
  }

  private cloneChannel(ch: Channel): Channel {
    return { ...ch, subscribers: [...ch.subscribers] };
  }
}
