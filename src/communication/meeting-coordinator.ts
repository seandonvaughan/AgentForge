/**
 * MeetingCoordinator — Sprint 2.2b
 *
 * Orchestrates agent meetings with hard concurrency limits (max 3 active).
 * Excess meetings queue with priority scoring. Designed to be triggered
 * by a PostToolUse hook (architect condition from review).
 *
 * Priority ladder (6 levels, highest first):
 *   1. escalation     — blocked agent, urgent
 *   2. decision       — approval needed
 *   3. review         — cross-agent review
 *   4. planning       — sprint planning
 *   5. sync           — routine status sync
 *   6. social         — optional connection
 *
 * COO condition: max 3 concurrent, queue with priority, 10-min CTO escalation.
 */

import { randomUUID } from "node:crypto";
import type {
  MeetingCoordinationPayload,
  V4MessagePriority,
} from "../types/v4-api.js";
import type { V4MessageBus } from "./v4-message-bus.js";

export const MEETING_CONCURRENCY_LIMIT = 3;
export const ESCALATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export type MeetingType =
  | "escalation"
  | "decision"
  | "review"
  | "planning"
  | "sync"
  | "social";

const MEETING_PRIORITY_RANK: Record<MeetingType, number> = {
  escalation: 0,
  decision:   1,
  review:     2,
  planning:   3,
  sync:       4,
  social:     5,
};

export interface MeetingRequest {
  agenda: string;
  participants: string[];
  meetingType: MeetingType;
  requestedBy: string;
  durationMinutes?: number;
  priority?: V4MessagePriority;
}

export interface MeetingRecord {
  meetingId: string;
  agenda: string;
  participants: string[];
  meetingType: MeetingType;
  requestedBy: string;
  durationMinutes: number;
  priority: V4MessagePriority;
  status: "scheduled" | "active" | "queued" | "completed" | "cancelled";
  queuePosition?: number;
  scheduledAt: string;
  startedAt?: string;
  completedAt?: string;
  escalatedAt?: string;
}

export class MeetingCoordinator {
  private meetings = new Map<string, MeetingRecord>();
  private activeMeetingIds = new Set<string>();
  private queuedMeetingIds: string[] = [];           // ordered by priority rank

  constructor(private readonly bus: V4MessageBus) {}

  /**
   * Request a meeting. If under the concurrency limit, schedules immediately.
   * Otherwise, queues by priority. Returns the meeting record.
   */
  requestMeeting(request: MeetingRequest): MeetingRecord {
    if (request.participants.length < 2) {
      throw new Error("A meeting requires at least 2 participants");
    }
    const meetingId = randomUUID();
    const now = new Date().toISOString();
    const activeMeetingCount = this.activeMeetingIds.size;
    const isUnderLimit = activeMeetingCount < MEETING_CONCURRENCY_LIMIT;

    const record: MeetingRecord = {
      meetingId,
      agenda: request.agenda,
      participants: [...request.participants],
      meetingType: request.meetingType,
      requestedBy: request.requestedBy,
      durationMinutes: request.durationMinutes ?? 30,
      priority: request.priority ?? "normal",
      status: isUnderLimit ? "scheduled" : "queued",
      scheduledAt: now,
    };

    if (!isUnderLimit) {
      record.queuePosition = this.insertIntoQueue(meetingId, request.meetingType);
      this.updateQueuePositions();
    }

    this.meetings.set(meetingId, record);
    this.publishStatus(record, isUnderLimit ? "meeting.coordination.scheduled" : "meeting.coordination.queued");
    return this.clone(record);
  }

  /**
   * Start a scheduled meeting. scheduled → active.
   */
  startMeeting(meetingId: string): MeetingRecord {
    const record = this.require(meetingId);
    if (record.status !== "scheduled") {
      throw new Error(`Meeting "${meetingId}" is "${record.status}" — expected "scheduled"`);
    }
    if (this.activeMeetingIds.size >= MEETING_CONCURRENCY_LIMIT) {
      throw new Error(
        `Cannot start meeting "${meetingId}" — at concurrency limit (${MEETING_CONCURRENCY_LIMIT})`
      );
    }
    this.activeMeetingIds.add(meetingId);
    const updated = this.updateRecord(meetingId, {
      status: "active",
      startedAt: new Date().toISOString(),
    });
    return updated;
  }

  /**
   * Complete an active meeting. active → completed. Promotes next queued.
   */
  completeMeeting(meetingId: string): MeetingRecord {
    const record = this.require(meetingId);
    if (record.status !== "active") {
      throw new Error(`Meeting "${meetingId}" is "${record.status}" — expected "active"`);
    }
    this.activeMeetingIds.delete(meetingId);
    const updated = this.updateRecord(meetingId, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    this.publishStatus(updated, "meeting.coordination.completed");
    this.promoteFromQueue();
    return updated;
  }

  /**
   * Cancel a meeting (any non-completed status). Promotes next queued if was active.
   */
  cancelMeeting(meetingId: string): MeetingRecord {
    const record = this.require(meetingId);
    if (record.status === "completed") {
      throw new Error(`Cannot cancel completed meeting "${meetingId}"`);
    }
    const wasActive = record.status === "active";
    this.activeMeetingIds.delete(meetingId);
    this.queuedMeetingIds = this.queuedMeetingIds.filter((id) => id !== meetingId);
    this.updateQueuePositions();
    const updated = this.updateRecord(meetingId, { status: "cancelled" });
    if (wasActive) this.promoteFromQueue();
    return updated;
  }

  /**
   * Escalate a queued meeting to CTO (signal timeout exceeded).
   * Records escalation timestamp; caller is responsible for notifying CTO.
   */
  escalateQueueTimeout(meetingId: string): MeetingRecord {
    const record = this.require(meetingId);
    if (record.status !== "queued") {
      throw new Error(`Meeting "${meetingId}" is not queued — cannot escalate timeout`);
    }
    return this.updateRecord(meetingId, { escalatedAt: new Date().toISOString() });
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  getMeeting(meetingId: string): MeetingRecord | null {
    const r = this.meetings.get(meetingId);
    return r ? this.clone(r) : null;
  }

  getActiveMeetings(): MeetingRecord[] {
    return Array.from(this.activeMeetingIds)
      .map((id) => this.meetings.get(id))
      .filter((r): r is MeetingRecord => r !== undefined)
      .map((r) => this.clone(r));
  }

  getQueuedMeetings(): MeetingRecord[] {
    return this.queuedMeetingIds
      .map((id) => this.meetings.get(id))
      .filter((r): r is MeetingRecord => r !== undefined)
      .map((r) => this.clone(r));
  }

  activeMeetingCount(): number {
    return this.activeMeetingIds.size;
  }

  queueLength(): number {
    return this.queuedMeetingIds.length;
  }

  totalMeetings(): number {
    return this.meetings.size;
  }

  /**
   * Returns meetings that have been queued longer than ESCALATION_TIMEOUT_MS
   * and haven't been escalated yet. Caller should invoke escalateQueueTimeout().
   */
  getOverdueQueuedMeetings(): MeetingRecord[] {
    const cutoff = Date.now() - ESCALATION_TIMEOUT_MS;
    return this.getQueuedMeetings().filter(
      (r) => new Date(r.scheduledAt).getTime() < cutoff && !r.escalatedAt
    );
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private insertIntoQueue(meetingId: string, type: MeetingType): number {
    const rank = MEETING_PRIORITY_RANK[type];
    let insertAt = this.queuedMeetingIds.length;
    for (let i = 0; i < this.queuedMeetingIds.length; i++) {
      const existingRecord = this.meetings.get(this.queuedMeetingIds[i]);
      if (existingRecord) {
        const existingRank = MEETING_PRIORITY_RANK[existingRecord.meetingType];
        if (rank < existingRank) {
          insertAt = i;
          break;
        }
      }
    }
    this.queuedMeetingIds.splice(insertAt, 0, meetingId);
    return insertAt + 1; // 1-based queue position
  }

  private updateQueuePositions(): void {
    for (let i = 0; i < this.queuedMeetingIds.length; i++) {
      const id = this.queuedMeetingIds[i];
      const record = this.meetings.get(id);
      if (record) {
        this.meetings.set(id, { ...record, queuePosition: i + 1 });
      }
    }
  }

  private promoteFromQueue(): void {
    if (
      this.queuedMeetingIds.length > 0 &&
      this.activeMeetingIds.size < MEETING_CONCURRENCY_LIMIT
    ) {
      const nextId = this.queuedMeetingIds.shift()!;
      this.updateQueuePositions();
      const record = this.meetings.get(nextId);
      if (record) {
        const updated = this.updateRecord(nextId, {
          status: "scheduled",
          queuePosition: undefined,
        });
        this.publishStatus(updated, "meeting.coordination.scheduled");
      }
    }
  }

  private updateRecord(meetingId: string, patch: Partial<MeetingRecord>): MeetingRecord {
    const existing = this.meetings.get(meetingId)!;
    const updated = { ...existing, ...patch };
    this.meetings.set(meetingId, updated);
    return this.clone(updated);
  }

  private publishStatus(record: MeetingRecord, topic: string): void {
    const payload: MeetingCoordinationPayload = {
      meetingId: record.meetingId,
      agenda: record.agenda,
      participants: record.participants,
      priority: record.priority,
      status: record.status === "scheduled" ? "scheduled"
            : record.status === "active" ? "active"
            : record.status === "completed" ? "completed"
            : record.status === "cancelled" ? "cancelled"
            : "requested",
      queuePosition: record.queuePosition,
      durationMinutes: record.durationMinutes,
      scheduledAt: record.scheduledAt,
    };
    this.bus.publish({
      from: "meeting-coordinator",
      to: record.requestedBy,
      topic,
      category: "meeting",
      payload,
      priority: record.priority,
    });
  }

  private require(meetingId: string): MeetingRecord {
    const record = this.meetings.get(meetingId);
    if (!record) throw new Error(`Meeting "${meetingId}" not found`);
    return record;
  }

  private clone(record: MeetingRecord): MeetingRecord {
    return { ...record, participants: [...record.participants] };
  }
}
