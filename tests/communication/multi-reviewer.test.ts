import { describe, it, expect, beforeEach } from "vitest";
import { MultiReviewer } from "../../src/communication/multi-reviewer.js";

describe("MultiReviewer", () => {
  let mr: MultiReviewer;
  beforeEach(() => { mr = new MultiReviewer(); });

  describe("submitForReview", () => {
    it("creates a review with multiple reviewers", () => {
      const r = mr.submitForReview({
        documentId: "doc-1", documentTitle: "Architecture",
        authorAgentId: "cto", reviewers: ["architect", "meta-architect", "ceo"],
      });
      expect(r.reviewers).toHaveLength(3);
      expect(r.status).toBe("in_review");
      expect(r.consensusRule).toBe("all");
    });
  });

  describe("consensus: all", () => {
    it("approved when all reviewers approve", () => {
      const r = mr.submitForReview({
        documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewers: ["a", "b", "c"], consensusRule: "all",
      });
      mr.submitVerdict(r.reviewId, "a", "approve");
      mr.submitVerdict(r.reviewId, "b", "approve");
      const final = mr.submitVerdict(r.reviewId, "c", "approve");
      expect(final.status).toBe("approved");
    });
    it("rejected when any reviewer requests changes", () => {
      const r = mr.submitForReview({
        documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewers: ["a", "b"], consensusRule: "all",
      });
      mr.submitVerdict(r.reviewId, "a", "approve");
      const final = mr.submitVerdict(r.reviewId, "b", "request_changes");
      expect(final.status).toBe("rejected");
    });
  });

  describe("consensus: majority", () => {
    it("approved when majority approves", () => {
      const r = mr.submitForReview({
        documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewers: ["a", "b", "c"], consensusRule: "majority",
      });
      mr.submitVerdict(r.reviewId, "a", "approve");
      mr.submitVerdict(r.reviewId, "b", "approve");
      const final = mr.submitVerdict(r.reviewId, "c", "request_changes");
      expect(final.status).toBe("approved"); // 2/3 majority
    });
    it("rejected when majority does not approve", () => {
      const r = mr.submitForReview({
        documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewers: ["a", "b", "c"], consensusRule: "majority",
      });
      mr.submitVerdict(r.reviewId, "a", "request_changes");
      mr.submitVerdict(r.reviewId, "b", "block");
      const final = mr.submitVerdict(r.reviewId, "c", "approve");
      expect(final.status).toBe("rejected"); // 1/3 not majority
    });
  });

  describe("inline comments", () => {
    it("attaches comments to verdict", () => {
      const r = mr.submitForReview({
        documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewers: ["arch"],
      });
      const result = mr.submitVerdict(r.reviewId, "arch", "request_changes", [
        { reviewerId: "arch", filePath: "src/bus.ts", lineNumber: 42, content: "Missing null check" },
      ]);
      expect(result.verdicts[0].comments).toHaveLength(1);
      expect(result.verdicts[0].comments[0].content).toBe("Missing null check");
      expect(result.verdicts[0].comments[0].resolved).toBe(false);
    });
    it("resolveComment marks comment as resolved", () => {
      const r = mr.submitForReview({
        documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewers: ["arch"],
      });
      const result = mr.submitVerdict(r.reviewId, "arch", "request_changes", [
        { reviewerId: "arch", filePath: "x.ts", lineNumber: 1, content: "Fix this" },
      ]);
      const commentId = result.verdicts[0].comments[0].commentId;
      mr.resolveComment(r.reviewId, commentId);
      expect(mr.getUnresolvedComments(r.reviewId)).toHaveLength(0);
    });
  });

  describe("getPendingReviewers", () => {
    it("returns reviewers who haven't submitted", () => {
      const r = mr.submitForReview({
        documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewers: ["a", "b", "c"],
      });
      mr.submitVerdict(r.reviewId, "a", "approve");
      expect(mr.getPendingReviewers(r.reviewId)).toEqual(["b", "c"]);
    });
  });

  describe("validation", () => {
    it("rejects non-reviewer submitting verdict", () => {
      const r = mr.submitForReview({
        documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewers: ["arch"],
      });
      expect(() => mr.submitVerdict(r.reviewId, "rogue", "approve")).toThrow(/not a reviewer/);
    });
    it("rejects duplicate verdict from same reviewer", () => {
      const r = mr.submitForReview({
        documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewers: ["arch"],
      });
      mr.submitVerdict(r.reviewId, "arch", "approve");
      expect(() => mr.submitVerdict(r.reviewId, "arch", "approve")).toThrow(/already submitted/);
    });
  });

  describe("immutability", () => {
    it("returned records are copies", () => {
      const r = mr.submitForReview({
        documentId: "d", documentTitle: "T",
        authorAgentId: "cto", reviewers: ["arch"],
      });
      const retrieved = mr.getReview(r.reviewId)!;
      retrieved.reviewers.push("hacker");
      expect(mr.getReview(r.reviewId)!.reviewers).toHaveLength(1);
    });
  });
});
