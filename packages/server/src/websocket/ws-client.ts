/**
 * Browser-side WebSocket client (ES module)
 *
 * Features:
 *  - Auto-reconnect with exponential backoff (1s → 2s → 4s → 8s → … → 30s max)
 *  - Event emitter pattern: on('message' | 'disconnect' | 'connect', cb)
 *  - send(data) — queues messages when disconnected, drains on reconnect
 *  - Responds to server heartbeat pings with pong
 *  - close() for clean teardown
 *
 * Usage (browser / SvelteKit):
 *
 *   import { WsClient } from '@agentforge/server/websocket/ws-client.js';
 *   const ws = new WsClient('ws://localhost:4750/ws');
 *   ws.on('message', (evt) => console.log(evt));
 *   ws.send({ type: 'chat', agentId: 'cto', message: 'Hello' });
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type WsEventType = 'connect' | 'disconnect' | 'message' | 'error';

export type WsEventHandler<T = unknown> = (data: T) => void;

export interface WsClientOptions {
  /** WebSocket URL, e.g. "ws://localhost:4750/ws". */
  url: string;
  /**
   * Backoff delays in milliseconds.
   * Defaults to [1000, 2000, 4000, 8000, 16000, 30000].
   */
  backoffDelays?: number[];
  /**
   * Maximum number of reconnect attempts before giving up.
   * Set to Infinity (default) to retry forever.
   */
  maxRetries?: number;
  /**
   * Maximum queue size for messages buffered while disconnected.
   * Oldest messages are dropped when the queue exceeds this limit.
   * Defaults to 100.
   */
  maxQueueSize?: number;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class WsClient {
  private readonly url: string;
  private readonly backoffDelays: number[];
  private readonly maxRetries: number;
  private readonly maxQueueSize: number;

  private ws: WebSocket | null = null;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  /** Messages buffered while the socket is not OPEN. */
  private sendQueue: unknown[] = [];

  /** Event listener registry. */
  private listeners: Map<WsEventType, Set<WsEventHandler<unknown>>> = new Map([
    ['connect', new Set()],
    ['disconnect', new Set()],
    ['message', new Set()],
    ['error', new Set()],
  ]);

  constructor(urlOrOpts: string | WsClientOptions) {
    if (typeof urlOrOpts === 'string') {
      this.url = urlOrOpts;
      this.backoffDelays = [1000, 2000, 4000, 8000, 16000, 30000];
      this.maxRetries = Infinity;
      this.maxQueueSize = 100;
    } else {
      this.url = urlOrOpts.url;
      this.backoffDelays = urlOrOpts.backoffDelays ?? [1000, 2000, 4000, 8000, 16000, 30000];
      this.maxRetries = urlOrOpts.maxRetries ?? Infinity;
      this.maxQueueSize = urlOrOpts.maxQueueSize ?? 100;
    }
    this.connect();
  }

  // ── Event emitter ────────────────────────────────────────────────────────────

  on<T = unknown>(event: WsEventType, handler: WsEventHandler<T>): this {
    this.listeners.get(event)?.add(handler as WsEventHandler<unknown>);
    return this;
  }

  off<T = unknown>(event: WsEventType, handler: WsEventHandler<T>): this {
    this.listeners.get(event)?.delete(handler as WsEventHandler<unknown>);
    return this;
  }

  private emit<T = unknown>(event: WsEventType, data: T): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        // Never let a handler error kill the client
        console.error('[WsClient] handler error:', err);
      }
    }
  }

  // ── Connection management ────────────────────────────────────────────────────

  private connect(): void {
    if (this.closed) return;

    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this.emit('error', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.retryCount = 0;
      this.emit('connect', undefined);
      this.drainQueue();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        parsed = event.data;
      }

      // Handle server heartbeat ping automatically
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as { type?: string }).type === 'ping'
      ) {
        this.rawSend({ type: 'pong', timestamp: new Date().toISOString() });
        return;
      }

      this.emit('message', parsed);
    };

    this.ws.onclose = (event: CloseEvent) => {
      this.emit('disconnect', { code: event.code, reason: event.reason, wasClean: event.wasClean });
      if (!this.closed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event: Event) => {
      this.emit('error', event);
      // onclose will fire afterwards and trigger reconnect
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.retryCount >= this.maxRetries) {
      this.emit('error', new Error(`WsClient: max retries (${this.maxRetries}) exceeded for ${this.url}`));
      return;
    }

    const delays = this.backoffDelays;
    const index = Math.min(this.retryCount, delays.length - 1);
    const delay = delays[index];

    this.retryTimer = setTimeout(() => {
      this.retryCount++;
      this.connect();
    }, delay);
  }

  // ── Sending ──────────────────────────────────────────────────────────────────

  /** Send a message, queuing if disconnected. */
  send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.rawSend(data);
    } else {
      this.enqueue(data);
    }
  }

  private rawSend(data: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.ws.send(payload);
  }

  private enqueue(data: unknown): void {
    this.sendQueue.push(data);
    if (this.sendQueue.length > this.maxQueueSize) {
      // Drop oldest
      this.sendQueue.shift();
    }
  }

  private drainQueue(): void {
    while (this.sendQueue.length > 0) {
      const item = this.sendQueue.shift();
      this.rawSend(item);
    }
  }

  // ── Replay helper ────────────────────────────────────────────────────────────

  /** Request missed events since a given timestamp from the server. */
  replay(since: Date | string): void {
    const iso = since instanceof Date ? since.toISOString() : since;
    this.send({ type: 'replay', since: iso });
  }

  // ── Chat helper ───────────────────────────────────────────────────────────────

  /** Send a chat message to a specific agent. */
  chat(agentId: string, message: string): void {
    this.send({ type: 'chat', agentId, message });
  }

  // ── Teardown ──────────────────────────────────────────────────────────────────

  /**
   * Cleanly close the WebSocket connection and stop auto-reconnect.
   * After calling close(), this instance cannot be reused.
   */
  close(): void {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'client closed');
      this.ws = null;
    }
    this.sendQueue = [];
  }

  // ── Introspection ─────────────────────────────────────────────────────────────

  get readyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get queuedMessages(): number {
    return this.sendQueue.length;
  }
}
