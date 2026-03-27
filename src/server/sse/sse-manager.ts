/**
 * SseManager — P0-6: Server-Sent Events client registry and broadcaster
 *
 * Maintains a registry of connected SSE clients and broadcasts events to all
 * of them in the standard SSE wire format: "event: <type>\ndata: <json>\n\n"
 *
 * Error isolation: write errors on individual client connections are caught,
 * the offending client is removed, and broadcasting continues for remaining
 * clients.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SseClient {
  id: string;
  reply: FastifyReply;
  connectedAt: string;
}

// ---------------------------------------------------------------------------
// SseManager
// ---------------------------------------------------------------------------

export class SseManager {
  private readonly clients = new Map<string, SseClient>();
  private readonly MAX_BUFFER = 100; // max simultaneous clients before evicting oldest

  /**
   * Register a new SSE client. Stores the client in the registry.
   * Call removeClient() when the connection closes.
   * Note: SSE response headers are set by the route handler.
   */
  addClient(id: string, reply: FastifyReply): void {
    // Evict the oldest client if we are at capacity
    if (this.clients.size >= this.MAX_BUFFER) {
      const oldestId = this.clients.keys().next().value;
      if (oldestId !== undefined) {
        process.stderr.write(
          `[SseManager] MAX_BUFFER (${this.MAX_BUFFER}) reached — evicting oldest client ${oldestId}\n`
        );
        const oldest = this.clients.get(oldestId);
        if (oldest) {
          try {
            oldest.reply.raw.end();
          } catch {
            // ignore
          }
        }
        this.clients.delete(oldestId);
      }
    }

    this.clients.set(id, {
      id,
      reply,
      connectedAt: new Date().toISOString(),
    });
  }

  /** Remove a client from the registry (call on socket close). */
  removeClient(id: string): void {
    this.clients.delete(id);
  }

  /**
   * Broadcast an event to all connected clients.
   * Clients that fail to receive the write are automatically removed.
   */
  broadcast(eventType: string, data: unknown): void {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    const toRemove: string[] = [];

    for (const [id, client] of this.clients) {
      try {
        client.reply.raw.write(payload);
      } catch (err) {
        process.stderr.write(
          `[SseManager] write error for client ${id}, removing: ${String(err)}\n`
        );
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.clients.delete(id);
    }
  }

  /** Return the number of currently connected clients. */
  getClientCount(): number {
    return this.clients.size;
  }

  /** Close all client connections and clear the registry. */
  destroy(): void {
    for (const [, client] of this.clients) {
      try {
        client.reply.raw.end();
      } catch {
        // ignore — socket may already be closed
      }
    }
    this.clients.clear();
  }
}
