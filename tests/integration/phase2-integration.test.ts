/**
 * Phase 2 Integration Tests — Sprint 2.4
 *
 * Gate criteria (from CTO v2 sprint plan):
 *  - V4MessageBus handles 1000 messages in < 200ms
 *  - Review routing exclusively via bus events (no file-system polling)
 *  - Session serialization round-trip fidelity
 *  - Meeting concurrency enforced at MEETING_CONCURRENCY_LIMIT (3)
 *  - ExecAssistant reduces surface area 80%+ (urgent+action / total)
 *  - All Phase 2 components compose cleanly on a shared bus
 */

import { describe, it, expect, beforeEach } from "vitest";
import { V4MessageBus, registerStandardTopics } from "../../src/communication/v4-message-bus.js";
import { ReviewRouter } from "../../src/communication/review-router.js";
import { MeetingCoordinator, MEETING_CONCURRENCY_LIMIT } from "../../src/communication/meeting-coordinator.js";
import { ChannelManager } from "../../src/communication/channel-manager.js";
import { ExecAssistant } from "../../src/communication/exec-assistant.js";

// ─── Shared bus factory ──────────────────────────────────────────────────────

function makeSharedBus() {
  const bus = new V4MessageBus();
  registerStandardTopics(bus);
  return bus;
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Bus throughput gate: 1000 messages < 200ms
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 2 gate — bus throughput", () => {
  it("publishes 1000 urgent messages in under 200ms", () => {
    const bus = makeSharedBus();
    const received: number[] = [];
    bus.subscribe("perf.test", (e) => received.push(e.payload as number));

    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      bus.publish({ from: "bench", to: "sink", topic: "perf.test",
        category: "status", payload: i, priority: "urgent" });
    }
    const elapsed = Date.now() - start;

    expect(received).toHaveLength(1000);
    expect(elapsed).toBeLessThan(200);
  });

  it("drains 1000 queued messages in under 200ms", () => {
    const bus = makeSharedBus();
    const received: number[] = [];
    bus.subscribe("perf.drain", (e) => received.push(e.payload as number));

    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      bus.publish({ from: "bench", to: "sink", topic: "perf.drain",
        category: "status", payload: i, priority: "normal" });
    }
    bus.drain();
    const elapsed = Date.now() - start;

    expect(received).toHaveLength(1000);
    expect(elapsed).toBeLessThan(200);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Review routing exclusively via bus (no polling)
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 2 gate — review routing via bus", () => {
  let bus: V4MessageBus;
  let router: ReviewRouter;
  let events: string[];

  beforeEach(() => {
    bus = makeSharedBus();
    router = new ReviewRouter(bus);
    events = [];
    bus.onAnyMessage((e) => events.push(e.topic));
  });

  it("full review lifecycle emits all expected bus events", () => {
    const r = router.submitForReview({
      documentId: "doc-phase2",
      documentTitle: "Phase 2 Architecture",
      authorAgentId: "cto",
      reviewerAgentId: "architect",
    });

    router.startReview(r.reviewId, "architect");
    router.submitFeedback(r.reviewId, "architect", "approve");
    router.resolveReview(r.reviewId, "cto");
    router.approve(r.reviewId, "ceo");

    expect(events).toContain("review.lifecycle.assigned");
    expect(events).toContain("review.lifecycle.responded");
    expect(events).toContain("review.lifecycle.approved");
  });

  it("bus history captures the full audit trail without file access", () => {
    const r = router.submitForReview({
      documentId: "doc-audit",
      documentTitle: "Audit Trail Doc",
      authorAgentId: "cto",
    });
    router.assignReviewer(r.reviewId, "architect");
    router.startReview(r.reviewId, "architect");
    router.submitFeedback(r.reviewId, "architect", "request_changes");
    router.resolveReview(r.reviewId, "cto");

    const history = bus.getHistory();
    const topics = history.map((e) => e.topic);
    expect(topics).toContain("review.lifecycle.assigned");
    expect(topics).toContain("review.lifecycle.responded");
    // All review events are in history — no file polling required
    expect(history.length).toBeGreaterThanOrEqual(3);
  });

  it("wildcard subscriber receives all review events after drain", () => {
    const reviewEvents: string[] = [];
    bus.subscribeWildcard("review", (e) => reviewEvents.push(e.topic));

    const r = router.submitForReview({
      documentId: "d",
      documentTitle: "T",
      authorAgentId: "cto",
      reviewerAgentId: "arch",
    });
    router.startReview(r.reviewId, "arch");
    router.submitFeedback(r.reviewId, "arch", "approve");
    router.resolveReview(r.reviewId, "cto");
    router.approve(r.reviewId, "ceo");

    bus.drain(); // deliver queued normal-priority events to subscribers

    expect(reviewEvents.every((t) => t.startsWith("review."))).toBe(true);
    expect(reviewEvents).toHaveLength(4); // assigned, responded, resolved, approved
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Meeting concurrency enforcement
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 2 gate — meeting concurrency", () => {
  let bus: V4MessageBus;
  let coord: MeetingCoordinator;

  beforeEach(() => {
    bus = makeSharedBus();
    coord = new MeetingCoordinator(bus);
  });

  it(`enforces MEETING_CONCURRENCY_LIMIT = ${MEETING_CONCURRENCY_LIMIT}`, () => {
    const active = [];
    for (let i = 0; i < MEETING_CONCURRENCY_LIMIT; i++) {
      const m = coord.requestMeeting({
        agenda: `fill-${i}`,
        participants: ["cto", "arch"],
        meetingType: "sync",
        requestedBy: "cto",
      });
      coord.startMeeting(m.meetingId);
      active.push(m.meetingId);
    }
    expect(coord.getActiveMeetings()).toHaveLength(MEETING_CONCURRENCY_LIMIT);

    const overflow = coord.requestMeeting({
      agenda: "overflow",
      participants: ["cto", "arch"],
      meetingType: "sync",
      requestedBy: "cto",
    });
    expect(overflow.status).toBe("queued");
  });

  it("completing a meeting auto-promotes the next queued", () => {
    const scheduled: string[] = [];
    for (let i = 0; i < MEETING_CONCURRENCY_LIMIT; i++) {
      const m = coord.requestMeeting({
        agenda: `fill-${i}`,
        participants: ["cto", "arch"],
        meetingType: "sync",
        requestedBy: "cto",
      });
      coord.startMeeting(m.meetingId);
      scheduled.push(m.meetingId);
    }
    const queued = coord.requestMeeting({
      agenda: "next-up",
      participants: ["cto", "arch"],
      meetingType: "escalation",
      requestedBy: "cto",
    });
    expect(queued.status).toBe("queued");

    coord.completeMeeting(scheduled[0]);
    expect(coord.getMeeting(queued.meetingId)!.status).toBe("scheduled");
  });

  it("priority ordering: escalation promotes before sync", () => {
    for (let i = 0; i < MEETING_CONCURRENCY_LIMIT; i++) {
      const m = coord.requestMeeting({
        agenda: `fill-${i}`, participants: ["a", "b"],
        meetingType: "sync", requestedBy: "a",
      });
      coord.startMeeting(m.meetingId);
    }
    coord.requestMeeting({ agenda: "low-sync", participants: ["a", "b"],
      meetingType: "sync", requestedBy: "a" });
    coord.requestMeeting({ agenda: "high-esc", participants: ["a", "b"],
      meetingType: "escalation", requestedBy: "a" });

    const queued = coord.getQueuedMeetings();
    expect(queued[0].meetingType).toBe("escalation");
  });

  it("meeting bus events are emitted for all lifecycle transitions", () => {
    const events: string[] = [];
    bus.onAnyMessage((e) => events.push(e.topic));

    const m = coord.requestMeeting({
      agenda: "lifecycle",
      participants: ["cto", "arch"],
      meetingType: "sync",
      requestedBy: "cto",
    });
    coord.startMeeting(m.meetingId);
    coord.completeMeeting(m.meetingId);

    expect(events).toContain("meeting.coordination.scheduled");
    expect(events).toContain("meeting.coordination.completed");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. ExecAssistant inbox reduction gate (80%+)
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 2 gate — ExecAssistant inbox reduction", () => {
  let channelMgr: ChannelManager;
  let assistant: ExecAssistant;

  beforeEach(() => {
    channelMgr = new ChannelManager();
    channelMgr.createChannel("ceo-inbox", "CEO Inbox", "Messages for CEO", "ceo");
    assistant = new ExecAssistant("ceo");
  });

  it("filters 80%+ of messages as fyi/noise, exposing only urgent+action", () => {
    // 2 urgent, 2 action, 6 fyi/noise → 80% filtered
    // 1 urgent + 1 action = 2 surfaced; 8 fyi/noise = 80% filtered
    channelMgr.post("ceo-inbox", "system", "P0 outage", "Production is down", { priority: "urgent" });
    channelMgr.post("ceo-inbox", "cto", "Budget approval", "Approve $50k", { category: "decision" });
    channelMgr.post("ceo-inbox", "cto", "Sprint done", "Phase 2 complete", { category: "status" });
    channelMgr.post("ceo-inbox", "cto", "PR merged", "PR #42 merged", { category: "review" });
    channelMgr.post("ceo-inbox", "cto", "Deploy note", "Deployed v3.2", { category: "status" });
    channelMgr.post("ceo-inbox", "cto", "Team lunch", "Next week", { priority: "low" });
    channelMgr.post("ceo-inbox", "cto", "Office supplies", "Ordered pens", { priority: "low" });
    channelMgr.post("ceo-inbox", "cto", "Low note", "Not important", { priority: "low" });
    channelMgr.post("ceo-inbox", "cto", "Weekly sync", "All good", { category: "status" });
    channelMgr.post("ceo-inbox", "cto", "Retro notes", "Captured", { category: "review" });

    const msgs = channelMgr.readUnconsumed("ceo-inbox");
    const briefing = assistant.generateBriefing(msgs);

    const surfaced = briefing.urgentItems.length + briefing.actionItems.length;
    const filtered = briefing.fyiCount + briefing.noiseCount;
    const reductionPct = (filtered / briefing.totalProcessed) * 100;

    expect(reductionPct).toBeGreaterThanOrEqual(80);
    expect(briefing.totalProcessed).toBe(10);
    expect(surfaced).toBeLessThanOrEqual(2);
  });

  it("requiresAttention is false when only fyi/noise present", () => {
    for (let i = 0; i < 5; i++) {
      channelMgr.post("ceo-inbox", "cto", `Update ${i}`, "body", { category: "status" });
    }
    const msgs = channelMgr.readUnconsumed("ceo-inbox");
    const briefing = assistant.generateBriefing(msgs);
    expect(assistant.requiresAttention(briefing)).toBe(false);
  });

  it("formatForPrompt produces concise no-action string when filtered", () => {
    channelMgr.post("ceo-inbox", "cto", "Weekly update", "All good", { category: "status" });
    const msgs = channelMgr.readUnconsumed("ceo-inbox");
    const prompt = assistant.formatForPrompt(assistant.generateBriefing(msgs));
    expect(prompt).toMatch(/no action required/i);
    expect(prompt.length).toBeLessThan(100);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Full Phase 2 composition: bus → review → meeting → channel → assistant
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 2 gate — full composition", () => {
  it("review approval triggers channel post which is triaged by ExecAssistant", () => {
    const bus = makeSharedBus();
    const router = new ReviewRouter(bus);
    const channelMgr = new ChannelManager();
    channelMgr.createChannel("ceo-inbox", "CEO Inbox", "", "ceo");

    // Wire bus → channel: when a review is approved, post to CEO inbox
    bus.subscribe("review.lifecycle.approved", (env) => {
      channelMgr.post("ceo-inbox", "review-system",
        "Review approved", `Document approved: ${(env.payload as { documentTitle: string }).documentTitle}`,
        { category: "status" });
    });

    const r = router.submitForReview({
      documentId: "arch-doc", documentTitle: "Architecture v4",
      authorAgentId: "cto", reviewerAgentId: "architect",
    });
    router.startReview(r.reviewId, "architect");
    router.submitFeedback(r.reviewId, "architect", "approve");
    router.resolveReview(r.reviewId, "cto");
    router.approve(r.reviewId, "ceo");

    bus.drain(); // deliver normal-priority review events to subscribers

    const msgs = channelMgr.readUnconsumed("ceo-inbox");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].subject).toBe("Review approved");

    const assistant = new ExecAssistant("ceo");
    const briefing = assistant.generateBriefing(msgs);
    // Status update → fyi, no Opus invocation needed
    expect(assistant.requiresAttention(briefing)).toBe(false);
    expect(briefing.fyiCount).toBe(1);
  });

  it("shared bus history provides a full audit log of all Phase 2 activity", () => {
    const bus = makeSharedBus();
    const router = new ReviewRouter(bus);
    const coord = new MeetingCoordinator(bus);

    const r = router.submitForReview({
      documentId: "d1", documentTitle: "Doc",
      authorAgentId: "cto", reviewerAgentId: "arch",
    });
    router.startReview(r.reviewId, "arch");
    router.submitFeedback(r.reviewId, "arch", "approve");
    router.resolveReview(r.reviewId, "cto");
    router.approve(r.reviewId, "ceo");

    const m = coord.requestMeeting({
      agenda: "Phase 2 retro",
      participants: ["cto", "arch"],
      meetingType: "review",
      requestedBy: "cto",
    });
    coord.startMeeting(m.meetingId);
    coord.completeMeeting(m.meetingId);

    const history = bus.getHistory();
    const topics = new Set(history.map((e) => e.topic));
    expect(topics.has("review.lifecycle.assigned")).toBe(true);
    expect(topics.has("review.lifecycle.approved")).toBe(true);
    expect(topics.has("meeting.coordination.scheduled")).toBe(true);
    expect(topics.has("meeting.coordination.completed")).toBe(true);
    // All activity captured — no file-system polling needed
    expect(history.length).toBeGreaterThanOrEqual(6);
  });
});
