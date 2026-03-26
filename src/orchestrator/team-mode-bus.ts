import { randomUUID } from "node:crypto";
import type { AgentAddressRegistry } from "./agent-address-registry.js";
import type { TeamModeMessage, TeamModeMessageType } from "../types/team-mode.js";
import type { MessagePriority } from "../types/message.js";

interface SendOptions {
  from: string;
  to: string;
  type: TeamModeMessageType;
  content: string;
  priority: MessagePriority;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

type MessageHandler = (message: TeamModeMessage) => void;

interface QueuedMessage {
  message: TeamModeMessage;
  priority: number;
}

const PRIORITY_RANK: Record<MessagePriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export class TeamModeBus {
  private registry: AgentAddressRegistry;
  private subscribers: Map<string, MessageHandler[]> = new Map();
  private globalListeners: MessageHandler[] = [];
  private queue: QueuedMessage[] = [];
  private history: TeamModeMessage[] = [];

  constructor(registry: AgentAddressRegistry) {
    this.registry = registry;
  }

  send(options: SendOptions): TeamModeMessage {
    if (!this.registry.hasAddress(options.from)) {
      throw new Error(`Unknown sender: ${options.from}`);
    }
    if (!this.registry.hasAddress(options.to)) {
      throw new Error(`Unknown recipient: ${options.to}`);
    }
    this.validateRouting(options.from, options.to);

    const message: TeamModeMessage = {
      id: randomUUID(),
      from: options.from,
      to: options.to,
      type: options.type,
      content: options.content,
      priority: options.priority,
      timestamp: new Date().toISOString(),
      replyTo: options.replyTo,
      metadata: options.metadata,
    };

    this.history.push(message);
    for (const listener of this.globalListeners) listener(message);

    if (options.priority === "urgent") {
      this.deliver(message);
    } else {
      this.queue.push({ message, priority: PRIORITY_RANK[options.priority] });
    }

    return message;
  }

  subscribe(address: string, handler: MessageHandler): void {
    const handlers = this.subscribers.get(address) ?? [];
    handlers.push(handler);
    this.subscribers.set(address, handlers);
  }

  onAnyMessage(handler: MessageHandler): void {
    this.globalListeners.push(handler);
  }

  drain(): void {
    this.queue.sort((a, b) => a.priority - b.priority);
    const toProcess = [...this.queue];
    this.queue = [];
    for (const { message } of toProcess) this.deliver(message);
  }

  getPendingCount(): number {
    return this.queue.length;
  }

  getHistory(): TeamModeMessage[] {
    return [...this.history];
  }

  private deliver(message: TeamModeMessage): void {
    const handlers = this.subscribers.get(message.to) ?? [];
    for (const handler of handlers) handler(message);
  }

  private validateRouting(from: string, to: string): void {
    if (from === "conduit:user" || to === "conduit:user") return;
    const fromName = from.split(":")[1]!;
    const toName = to.split(":")[1]!;
    if (!this.registry.canRoute(fromName, toName)) {
      throw new Error(`Routing from ${from} to ${to} not allowed by delegation graph`);
    }
  }
}