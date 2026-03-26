/**
 * V4SessionManager — Sprint 4.1 + 4.2a
 *
 * Session lifecycle: create → active ↔ persisted → completed/expired
 * Cross-session context threading: link sessions to prior context.
 * Timeout policies vary by AutonomyTier (1=15m, 2=30m, 3=60m, 4=120m).
 * Serializable for persistence across process restarts.
 */

import { randomUUID } from "node:crypto";
import type { V4MessageBus } from "../communication/v4-message-bus.js";

export type V4SessionStatus = "active" | "persisted" | "completed" | "expired";

export interface ContextLink {
  sourceSessionId: string;
  content: string;
  linkedAt: string;
}

export interface V4Session {
  sessionId: string;
  taskDescription: string;
  agentId: string;
  autonomyTier: number;
  status: V4SessionStatus;
  createdAt: string;
  updatedAt: string;
  result?: string;
  resumeCount: number;
  contextChain: ContextLink[];
}

export interface SessionCreateInput {
  taskDescription: string;
  agentId: string;
  autonomyTier: number;
}

const TIMEOUT_BY_TIER: Record<number, number> = {
  1: 15 * 60 * 1000,   // 15 min
  2: 30 * 60 * 1000,   // 30 min
  3: 60 * 60 * 1000,   // 60 min
  4: 120 * 60 * 1000,  // 120 min
};

export class V4SessionManager {
  private sessions = new Map<string, V4Session>();

  constructor(private readonly bus?: V4MessageBus) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  create(input: SessionCreateInput): V4Session {
    const now = new Date().toISOString();
    const session: V4Session = {
      sessionId: randomUUID(),
      taskDescription: input.taskDescription,
      agentId: input.agentId,
      autonomyTier: input.autonomyTier,
      status: "active",
      createdAt: now,
      updatedAt: now,
      resumeCount: 0,
      contextChain: [],
    };
    this.sessions.set(session.sessionId, session);
    if (this.bus) {
      this.bus.publish({
        from: "session-manager",
        to: "broadcast",
        topic: "session.created",
        category: "status",
        payload: this.clone(session),
        priority: "normal",
      });
    }
    return this.clone(session);
  }

  persist(sessionId: string): V4Session {
    const s = this.require(sessionId);
    if (s.status !== "active") {
      throw new Error(`Session "${sessionId}" must be active to persist (current: "${s.status}")`);
    }
    const result = this.update(sessionId, { status: "persisted" });
    if (this.bus) {
      this.bus.publish({
        from: "session-manager",
        to: "broadcast",
        topic: "session.persisted",
        category: "status",
        payload: { sessionId },
        priority: "normal",
      });
    }
    return result;
  }

  resume(sessionId: string): V4Session {
    const s = this.require(sessionId);
    if (s.status !== "persisted") {
      throw new Error(`Session "${sessionId}" must be persisted to resume (current: "${s.status}")`);
    }
    const result = this.update(sessionId, { status: "active", resumeCount: s.resumeCount + 1 });
    if (this.bus) {
      this.bus.publish({
        from: "session-manager",
        to: "broadcast",
        topic: "session.resumed",
        category: "status",
        payload: { sessionId },
        priority: "normal",
      });
    }
    return result;
  }

  complete(sessionId: string, result: string): V4Session {
    const s = this.require(sessionId);
    if (s.status === "completed" || s.status === "expired") {
      throw new Error(`Session "${sessionId}" is already completed/expired`);
    }
    const updated = this.update(sessionId, { status: "completed", result });
    if (this.bus) {
      this.bus.publish({
        from: "session-manager",
        to: "broadcast",
        topic: "session.completed",
        category: "status",
        payload: { sessionId, result },
        priority: "normal",
      });
    }
    return updated;
  }

  expire(sessionId: string, reason: string): V4Session {
    const s = this.require(sessionId);
    if (s.status === "completed" || s.status === "expired") {
      throw new Error(`Session "${sessionId}" is already completed/expired`);
    }
    const updated = this.update(sessionId, { status: "expired", result: reason });
    if (this.bus) {
      this.bus.publish({
        from: "session-manager",
        to: "broadcast",
        topic: "session.expired",
        category: "status",
        payload: { sessionId, reason },
        priority: "normal",
      });
    }
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  get(sessionId: string): V4Session | null {
    const s = this.sessions.get(sessionId);
    return s ? this.clone(s) : null;
  }

  list(): V4Session[] {
    return Array.from(this.sessions.values()).map((s) => this.clone(s));
  }

  listActive(): V4Session[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.status === "active")
      .map((s) => this.clone(s));
  }

  // ---------------------------------------------------------------------------
  // Cross-session context (Sprint 4.2a)
  // ---------------------------------------------------------------------------

  addContext(sessionId: string, sourceSessionId: string, content: string): void {
    const s = this.require(sessionId);
    s.contextChain.push({
      sourceSessionId,
      content,
      linkedAt: new Date().toISOString(),
    });
    s.updatedAt = new Date().toISOString();
  }

  getContextChain(sessionId: string): ContextLink[] {
    const s = this.require(sessionId);
    return s.contextChain.map((c) => ({ ...c }));
  }

  // ---------------------------------------------------------------------------
  // Timeout policies
  // ---------------------------------------------------------------------------

  getTimeoutMs(autonomyTier: number): number {
    return TIMEOUT_BY_TIER[autonomyTier] ?? TIMEOUT_BY_TIER[1];
  }

  // ---------------------------------------------------------------------------
  // Resource cleanup
  // ---------------------------------------------------------------------------

  cleanup(thresholdMs: number): number {
    const now = Date.now();
    let count = 0;
    for (const [id, s] of this.sessions) {
      if ((s.status === "expired" || s.status === "completed") &&
          now - new Date(s.updatedAt).getTime() > thresholdMs) {
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  toJSON(): string {
    return JSON.stringify(Array.from(this.sessions.values()));
  }

  static fromJSON(json: string): V4SessionManager {
    const mgr = new V4SessionManager();
    const entries = JSON.parse(json) as V4Session[];
    for (const s of entries) {
      mgr.sessions.set(s.sessionId, s);
    }
    return mgr;
  }

  // ---------------------------------------------------------------------------
  // Test helper
  // ---------------------------------------------------------------------------

  _setForTest(sessionId: string, session: V4Session): void {
    this.sessions.set(sessionId, session);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private require(sessionId: string): V4Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session "${sessionId}" not found`);
    return s;
  }

  private update(sessionId: string, patch: Partial<V4Session>): V4Session {
    const s = this.require(sessionId);
    Object.assign(s, patch, { updatedAt: new Date().toISOString() });
    return this.clone(s);
  }

  private clone(session: V4Session): V4Session {
    return {
      ...session,
      contextChain: session.contextChain.map((c) => ({ ...c })),
    };
  }
}
