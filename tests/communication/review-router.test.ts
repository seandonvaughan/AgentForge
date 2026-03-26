import { describe, it, expect, beforeEach } from "vitest";
import { V4MessageBus } from "../../src/communication/v4-message-bus.js";
import { ReviewRouter } from "../../src/communication/review-router.js";

function makeRouter() {
  const bus = new V4MessageBus();
  const router = new ReviewRouter(bus);
  return { bus, router };
}

describe("ReviewRouter", () => {
  let bus: V4MessageBus;
  let router: ReviewRouter;
  beforeEach(() => { ({ bus, router } = makeRouter()); });

  describe("submitForReview", () => {
    it("creates a pending review", () => {
      const r = router.submitForReview({ documentId: "doc-1", documentTitle: "Sprint Plan",
        authorAgentId: "cto" });
      expect(r.status).toBe("pending");
      expect(r.authorAgentId).toBe("cto");
      expect(r.reviewerAgentId).toBeNull();
    });
    it("auto-assigns reviewer if provided", () => {
      const r = router.submitForReview({ documentId: "doc-1", documentTitle: "Sprint Plan",
        authorAgentId: "cto", reviewerAgentId: "architect" });
      expect(r.status).toBe("assigned");
      expect(r.reviewerAgentId).toBe("architect");
    });
    it("publishes bus message on auto-assign", () => {
      const events: string[] = [];
      bus.onAnyMessage((e) => events.push(e.topic));
      router.submitForReview({ documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewerAgentId: "architect" });
      expect(events).toContain("review.lifecycle.assigned");
    });
  });

  describe("assignReviewer", () => {
    it("transitions pending → assigned", () => {
      const r = router.submitForReview({ documentId: "d", documentTitle: "T", authorAgentId: "cto" });
      const assigned = router.assignReviewer(r.reviewId, "architect");
      expect(assigned.status).toBe("assigned");
    });
    it("throws if not pending", () => {
      const r = router.submitForReview({ documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewerAgentId: "architect" });
      expect(() => router.assignReviewer(r.reviewId, "meta-architect")).toThrow(/assigned/);
    });
  });

  describe("startReview", () => {
    it("assigned → in_review", () => {
      const r = router.submitForReview({ documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewerAgentId: "architect" });
      const started = router.startReview(r.reviewId, "architect");
      expect(started.status).toBe("in_review");
    });
    it("throws if wrong reviewer", () => {
      const r = router.submitForReview({ documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewerAgentId: "architect" });
      expect(() => router.startReview(r.reviewId, "coo")).toThrow(/cannot start/);
    });
  });

  describe("submitFeedback", () => {
    it("in_review → responded with verdict", () => {
      const r = router.submitForReview({ documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewerAgentId: "architect" });
      router.startReview(r.reviewId, "architect");
      const responded = router.submitFeedback(r.reviewId, "architect", "approve");
      expect(responded.status).toBe("responded");
      expect(responded.verdict).toBe("approve");
    });
    it("publishes responded event", () => {
      const events: string[] = [];
      bus.onAnyMessage((e) => events.push(e.topic));
      const r = router.submitForReview({ documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewerAgentId: "architect" });
      router.startReview(r.reviewId, "architect");
      router.submitFeedback(r.reviewId, "architect", "request_changes");
      expect(events).toContain("review.lifecycle.responded");
    });
  });

  describe("resolveReview", () => {
    it("responded → resolved", () => {
      const r = router.submitForReview({ documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewerAgentId: "architect" });
      router.startReview(r.reviewId, "architect");
      router.submitFeedback(r.reviewId, "architect", "request_changes");
      const resolved = router.resolveReview(r.reviewId, "cto");
      expect(resolved.status).toBe("resolved");
    });
    it("throws if wrong author", () => {
      const r = router.submitForReview({ documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewerAgentId: "architect" });
      router.startReview(r.reviewId, "architect");
      router.submitFeedback(r.reviewId, "architect", "approve");
      expect(() => router.resolveReview(r.reviewId, "coo")).toThrow(/author/);
    });
  });

  describe("approve", () => {
    it("resolved → approved", () => {
      const r = router.submitForReview({ documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewerAgentId: "architect" });
      router.startReview(r.reviewId, "architect");
      router.submitFeedback(r.reviewId, "architect", "approve");
      router.resolveReview(r.reviewId, "cto");
      const approved = router.approve(r.reviewId, "ceo");
      expect(approved.status).toBe("approved");
    });
    it("publishes approved event", () => {
      const events: string[] = [];
      bus.onAnyMessage((e) => events.push(e.topic));
      const r = router.submitForReview({ documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewerAgentId: "architect" });
      router.startReview(r.reviewId, "architect");
      router.submitFeedback(r.reviewId, "architect", "approve");
      router.resolveReview(r.reviewId, "cto");
      router.approve(r.reviewId, "ceo");
      expect(events).toContain("review.lifecycle.approved");
    });
  });

  describe("query", () => {
    it("getReviewsForDocument returns all reviews for doc", () => {
      router.submitForReview({ documentId: "doc-1", documentTitle: "T", authorAgentId: "cto" });
      router.submitForReview({ documentId: "doc-1", documentTitle: "T", authorAgentId: "cto" });
      router.submitForReview({ documentId: "doc-2", documentTitle: "T2", authorAgentId: "coo" });
      expect(router.getReviewsForDocument("doc-1")).toHaveLength(2);
    });
    it("getReviewsAssignedTo returns reviewer's assignments", () => {
      router.submitForReview({ documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewerAgentId: "architect" });
      expect(router.getReviewsAssignedTo("architect")).toHaveLength(1);
    });
    it("getPendingReviews returns only pending", () => {
      router.submitForReview({ documentId: "d1", documentTitle: "T1", authorAgentId: "cto" });
      router.submitForReview({ documentId: "d2", documentTitle: "T2",
        authorAgentId: "cto", reviewerAgentId: "architect" });
      expect(router.getPendingReviews()).toHaveLength(1);
    });
  });
});
