/**
 * BusFileAdapter — Sprint 4.4 P0-3
 *
 * Attaches to a V4MessageBus instance and persists every message to a
 * JSON array on disk. This lets the dashboard Bus Monitor and other
 * tools read real events from actual invoke runs.
 *
 * File format: JSON array of BusEvent objects at `filePath`.
 * Rolling: only the last `maxEvents` entries are kept.
 *
 * Usage:
 *   const adapter = new BusFileAdapter(".agentforge/data/bus-events.json");
 *   adapter.attach(bus);         // subscribe to all messages
 *   await adapter.flush();       // write pending events to disk
 *   const events = await adapter.load();
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { V4MessageBus } from "./v4-message-bus.js";
import type { MessageEnvelope } from "../types/v4-api.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BusEvent {
  topic: string;
  payload: unknown;
  timestamp: string;
  priority?: string;
  from?: string;
  to?: string;
  id?: string;
}

// ---------------------------------------------------------------------------
// BusFileAdapter
// ---------------------------------------------------------------------------

export class BusFileAdapter {
  private pending: BusEvent[] = [];
  private unsubscribe?: () => void;

  constructor(
    private readonly filePath: string,
    private readonly maxEvents: number = 500
  ) {}

  /**
   * Subscribe to all messages on the bus via `onAnyMessage`.
   * Each message is buffered; call `flush()` to write to disk.
   *
   * Calling attach() a second time detaches the previous listener first.
   */
  attach(bus: V4MessageBus): void {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    this.unsubscribe = bus.onAnyMessage((envelope: MessageEnvelope) => {
      this.pending.push(envelopeToEvent(envelope));
    });
  }

  /**
   * Detach from the bus (stops receiving new events).
   */
  detach(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  /**
   * Write all pending events to disk, merged with any existing events.
   * Keeps only the last `maxEvents` entries (rolling window).
   * Creates parent directories as needed.
   */
  async flush(): Promise<void> {
    if (this.pending.length === 0) return;

    await mkdir(dirname(this.filePath), { recursive: true });

    const existing = await this.load();
    const merged = [...existing, ...this.pending];
    const rolling = merged.slice(-this.maxEvents);

    await writeFile(this.filePath, JSON.stringify(rolling, null, 2), "utf8");
    this.pending = [];
  }

  /**
   * Read the current events file from disk.
   * Returns [] if the file does not exist yet.
   */
  async load(): Promise<BusEvent[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as BusEvent[];
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") return [];
      throw err;
    }
  }

  /**
   * How many events are buffered and not yet flushed.
   */
  pendingCount(): number {
    return this.pending.length;
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function envelopeToEvent(envelope: MessageEnvelope): BusEvent {
  return {
    topic: envelope.topic,
    payload: envelope.payload,
    timestamp: envelope.timestamp,
    priority: envelope.priority,
    from: envelope.from,
    to: envelope.to,
    id: envelope.id,
  };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
