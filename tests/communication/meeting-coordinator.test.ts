import { describe, it, expect, beforeEach } from "vitest";
import { V4MessageBus } from "../../src/communication/v4-message-bus.js";
import { MeetingCoordinator, MEETING_CONCURRENCY_LIMIT } from "../../src/communication/meeting-coordinator.js";

function makeMR(overrides?: Partial<Parameters<MeetingCoordinator["requestMeeting"]>[0]>) {
  return {
    agenda: "Sprint sync",
    participants: ["cto", "architect"],
    meetingType: "sync" as const,
    requestedBy: "cto",
    ...overrides,
  };
}

describe("MeetingCoordinator", () => {
  let bus: V4MessageBus;
  let coord: MeetingCoordinator;
  beforeEach(() => {
    bus = new V4MessageBus();
    coord = new MeetingCoordinator(bus);
  });

  describe("requestMeeting", () => {
    it("schedules a meeting when under limit", () => {
      const m = coord.requestMeeting(makeMR());
      expect(m.status).toBe("scheduled");
      expect(m.queuePosition).toBeUndefined();
    });
    it("queues when at concurrency limit", () => {
      for (let i = 0; i < MEETING_CONCURRENCY_LIMIT; i++) {
        const m = coord.requestMeeting(makeMR({ agenda: `mtg-${i}` }));
        coord.startMeeting(m.meetingId);
      }
      const queued = coord.requestMeeting(makeMR({ agenda: "overflow" }));
      expect(queued.status).toBe("queued");
      expect(queued.queuePosition).toBe(1);
    });
    it("throws with fewer than 2 participants", () => {
      expect(() => coord.requestMeeting({ ...makeMR(), participants: ["cto"] }))
        .toThrow(/2 participants/);
    });
    it("publishes scheduled event", () => {
      const events: string[] = [];
      bus.onAnyMessage((e) => events.push(e.topic));
      coord.requestMeeting(makeMR());
      expect(events).toContain("meeting.coordination.scheduled");
    });
    it("publishes queued event when at limit", () => {
      const events: string[] = [];
      for (let i = 0; i < MEETING_CONCURRENCY_LIMIT; i++) {
        const m = coord.requestMeeting(makeMR({ agenda: `m${i}` }));
        coord.startMeeting(m.meetingId);
      }
      bus.onAnyMessage((e) => events.push(e.topic));
      coord.requestMeeting(makeMR({ agenda: "queued" }));
      expect(events).toContain("meeting.coordination.queued");
    });
  });

  describe("startMeeting", () => {
    it("transitions scheduled → active", () => {
      const m = coord.requestMeeting(makeMR());
      coord.startMeeting(m.meetingId);
      expect(coord.getMeeting(m.meetingId)!.status).toBe("active");
    });
    it("throws if not scheduled", () => {
      const m = coord.requestMeeting(makeMR());
      coord.startMeeting(m.meetingId);
      expect(() => coord.startMeeting(m.meetingId)).toThrow(/scheduled/);
    });
    it("enforces concurrency limit", () => {
      const meetings = [];
      for (let i = 0; i < MEETING_CONCURRENCY_LIMIT; i++) {
        const m = coord.requestMeeting(makeMR({ agenda: `m${i}` }));
        coord.startMeeting(m.meetingId);
        meetings.push(m);
      }
      const extra = coord.requestMeeting(makeMR({ agenda: "extra" }));
      // extra is queued not scheduled — cannot start
      expect(() => coord.startMeeting(extra.meetingId)).toThrow();
    });
  });

  describe("completeMeeting", () => {
    it("active → completed and promotes from queue", () => {
      const m1 = coord.requestMeeting(makeMR({ agenda: "m1" }));
      coord.startMeeting(m1.meetingId);
      for (let i = 1; i < MEETING_CONCURRENCY_LIMIT; i++) {
        const m = coord.requestMeeting(makeMR({ agenda: `m${i+1}` }));
        coord.startMeeting(m.meetingId);
      }
      const queued = coord.requestMeeting(makeMR({ agenda: "queued" }));
      expect(queued.status).toBe("queued");

      coord.completeMeeting(m1.meetingId);
      expect(coord.getMeeting(m1.meetingId)!.status).toBe("completed");
      // Queued meeting should have been promoted
      const promoted = coord.getMeeting(queued.meetingId)!;
      expect(promoted.status).toBe("scheduled");
    });
    it("throws if not active", () => {
      const m = coord.requestMeeting(makeMR());
      expect(() => coord.completeMeeting(m.meetingId)).toThrow(/active/);
    });
    it("publishes completed event", () => {
      const events: string[] = [];
      const m = coord.requestMeeting(makeMR());
      coord.startMeeting(m.meetingId);
      bus.onAnyMessage((e) => events.push(e.topic));
      coord.completeMeeting(m.meetingId);
      expect(events).toContain("meeting.coordination.completed");
    });
  });

  describe("cancelMeeting", () => {
    it("cancels a scheduled meeting", () => {
      const m = coord.requestMeeting(makeMR());
      coord.cancelMeeting(m.meetingId);
      expect(coord.getMeeting(m.meetingId)!.status).toBe("cancelled");
    });
    it("cancels an active meeting and promotes queue", () => {
      const m1 = coord.requestMeeting(makeMR({ agenda: "m1" }));
      coord.startMeeting(m1.meetingId);
      for (let i = 1; i < MEETING_CONCURRENCY_LIMIT; i++) {
        const m = coord.requestMeeting(makeMR({ agenda: `m${i+1}` }));
        coord.startMeeting(m.meetingId);
      }
      const queued = coord.requestMeeting(makeMR({ agenda: "q" }));
      coord.cancelMeeting(m1.meetingId);
      expect(coord.getMeeting(queued.meetingId)!.status).toBe("scheduled");
    });
    it("throws if already completed", () => {
      const m = coord.requestMeeting(makeMR());
      coord.startMeeting(m.meetingId);
      coord.completeMeeting(m.meetingId);
      expect(() => coord.cancelMeeting(m.meetingId)).toThrow(/completed/);
    });
  });

  describe("priority ordering in queue", () => {
    it("escalation queues before sync", () => {
      for (let i = 0; i < MEETING_CONCURRENCY_LIMIT; i++) {
        const m = coord.requestMeeting(makeMR({ agenda: `fill${i}` }));
        coord.startMeeting(m.meetingId);
      }
      coord.requestMeeting(makeMR({ agenda: "sync", meetingType: "sync" }));
      coord.requestMeeting(makeMR({ agenda: "escalation", meetingType: "escalation" }));
      const queued = coord.getQueuedMeetings();
      expect(queued[0].meetingType).toBe("escalation");
    });
  });

  describe("query", () => {
    it("getActiveMeetings returns only active", () => {
      const m = coord.requestMeeting(makeMR());
      coord.startMeeting(m.meetingId);
      expect(coord.getActiveMeetings()).toHaveLength(1);
    });
    it("getQueuedMeetings returns queued in order", () => {
      for (let i = 0; i < MEETING_CONCURRENCY_LIMIT; i++) {
        const m = coord.requestMeeting(makeMR({ agenda: `fill${i}` }));
        coord.startMeeting(m.meetingId);
      }
      coord.requestMeeting(makeMR({ agenda: "q1" }));
      coord.requestMeeting(makeMR({ agenda: "q2" }));
      expect(coord.getQueuedMeetings()).toHaveLength(2);
      expect(coord.getQueuedMeetings()[0].agenda).toBe("q1");
    });
  });
});
