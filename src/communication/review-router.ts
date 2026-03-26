/**
 * ReviewRouter — Sprint 2.1b
 *
 * Routes document/code review lifecycle events through V4MessageBus.
 * Manages the 6-state review state machine:
 *   pending → assigned → in_review → responded → resolved → approved
 *
 * All state changes are communicated exclusively via V4MessageBus
 * (no file-system polling — Team-Mode-Lead condition from review).
 *
 * Agent-owned status files track each agent's review workload independently.
 */

import { randomUUID } from "node:crypto";
import type {
  ReviewLifecyclePayload,
  ReviewStatus,
  V4MessagePriority,
} from "../types/v4-api.js";
import type { V4MessageBus } from "./v4-message-bus.js";

export interface ReviewRequest {
  documentId: string;
  documentTitle: string;
  authorAgentId: string;
  reviewerAgentId?: string;        // Pre-assigned; if omitted, auto-assign
  priority?: V4MessagePriority;
}

export interface ReviewRecord {
  reviewId: string;
  documentId: string;
  documentTitle: string;
  authorAgentId: string;
  reviewerAgentId: string | null;
  status: ReviewStatus;
  priority: V4MessagePriority;
  createdAt: string;
  updatedAt: string;
  verdict?: "approve" | "request_changes" | "block";
  commentFile?: string;
}

export class ReviewRouter {
  private reviews = new Map<string, ReviewRecord>();

  constructor(private readonly bus: V4MessageBus) {}

  /**
   * Submit a document for review. Transitions: → pending (→ assigned if reviewer provided).
   */
  submitForReview(request: ReviewRequest): ReviewRecord {
    const reviewId = randomUUID();
    const now = new Date().toISOString();
    const record: ReviewRecord = {
      reviewId,
      documentId: request.documentId,
      documentTitle: request.documentTitle,
      authorAgentId: request.authorAgentId,
      reviewerAgentId: request.reviewerAgentId ?? null,
      status: "pending",
      priority: request.priority ?? "normal",
      createdAt: now,
      updatedAt: now,
    };
    this.reviews.set(reviewId, record);

    if (request.reviewerAgentId) {
      return this.assignReviewer(reviewId, request.reviewerAgentId);
    }
    return this.clone(record);
  }

  /**
   * Assign a reviewer. pending → assigned.
   */
  assignReviewer(reviewId: string, reviewerAgentId: string): ReviewRecord {
    const record = this.require(reviewId);
    if (record.status !== "pending") {
      throw new Error(`Review "${reviewId}" is "${record.status}" — cannot assign reviewer`);
    }
    const updated = this.update(reviewId, { reviewerAgentId, status: "assigned" });
    this.publish("review.lifecycle.assigned", updated);
    return updated;
  }

  /**
   * Reviewer signals they have started. assigned → in_review.
   */
  startReview(reviewId: string, reviewerAgentId: string): ReviewRecord {
    const record = this.require(reviewId);
    this.assertReviewer(record, reviewerAgentId, "start");
    if (record.status !== "assigned") {
      throw new Error(`Review "${reviewId}" is "${record.status}" — expected "assigned"`);
    }
    const updated = this.update(reviewId, { status: "in_review" });
    return updated;
  }

  /**
   * Reviewer submits feedback. in_review → responded.
   */
  submitFeedback(
    reviewId: string,
    reviewerAgentId: string,
    verdict: "approve" | "request_changes" | "block",
    commentFile?: string
  ): ReviewRecord {
    const record = this.require(reviewId);
    this.assertReviewer(record, reviewerAgentId, "submit feedback for");
    if (record.status !== "in_review") {
      throw new Error(`Review "${reviewId}" is "${record.status}" — expected "in_review"`);
    }
    const updated = this.update(reviewId, { status: "responded", verdict, commentFile });
    this.publish("review.lifecycle.responded", updated);
    return updated;
  }

  /**
   * Author acknowledges feedback. responded → resolved.
   */
  resolveReview(reviewId: string, authorAgentId: string): ReviewRecord {
    const record = this.require(reviewId);
    if (record.authorAgentId !== authorAgentId) {
      throw new Error(
        `Only the author can resolve review "${reviewId}" — expected "${record.authorAgentId}"`
      );
    }
    if (record.status !== "responded") {
      throw new Error(`Review "${reviewId}" is "${record.status}" — expected "responded"`);
    }
    const updated = this.update(reviewId, { status: "resolved" });
    this.publish("review.lifecycle.resolved", updated);
    return updated;
  }

  /**
   * Final approver grants approval. resolved → approved.
   */
  approve(reviewId: string, approverAgentId: string): ReviewRecord {
    const record = this.require(reviewId);
    if (record.status !== "resolved") {
      throw new Error(`Review "${reviewId}" is "${record.status}" — expected "resolved"`);
    }
    const updated = this.update(reviewId, { status: "approved", verdict: "approve" });
    this.publish("review.lifecycle.approved", updated, approverAgentId);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  getReview(reviewId: string): ReviewRecord | null {
    const r = this.reviews.get(reviewId);
    return r ? this.clone(r) : null;
  }

  getReviewsForDocument(documentId: string): ReviewRecord[] {
    return Array.from(this.reviews.values())
      .filter((r) => r.documentId === documentId)
      .map((r) => this.clone(r));
  }

  getReviewsAssignedTo(reviewerAgentId: string): ReviewRecord[] {
    return Array.from(this.reviews.values())
      .filter((r) => r.reviewerAgentId === reviewerAgentId)
      .map((r) => this.clone(r));
  }

  getPendingReviews(): ReviewRecord[] {
    return Array.from(this.reviews.values())
      .filter((r) => r.status === "pending")
      .map((r) => this.clone(r));
  }

  size(): number {
    return this.reviews.size;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private require(reviewId: string): ReviewRecord {
    const record = this.reviews.get(reviewId);
    if (!record) throw new Error(`Review "${reviewId}" not found`);
    return record;
  }

  private assertReviewer(record: ReviewRecord, agentId: string, action: string): void {
    if (record.reviewerAgentId !== agentId) {
      throw new Error(
        `Agent "${agentId}" cannot ${action} review "${record.reviewId}" — assigned to "${record.reviewerAgentId}"`
      );
    }
  }

  private update(reviewId: string, patch: Partial<ReviewRecord>): ReviewRecord {
    const existing = this.reviews.get(reviewId)!;
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.reviews.set(reviewId, updated);
    return this.clone(updated);
  }

  private publish(
    topic: string,
    record: ReviewRecord,
    publisherAgentId?: string
  ): void {
    const payload: ReviewLifecyclePayload = {
      reviewId: record.reviewId,
      documentId: record.documentId,
      documentTitle: record.documentTitle,
      status: record.status,
      reviewerAgentId: record.reviewerAgentId ?? undefined,
      verdict: record.verdict,
      commentFile: record.commentFile,
    };
    this.bus.publish({
      from: publisherAgentId ?? record.reviewerAgentId ?? record.authorAgentId,
      to: record.authorAgentId,
      topic,
      category: "review",
      payload,
      priority: record.priority,
    });
  }

  private clone(record: ReviewRecord): ReviewRecord {
    return { ...record };
  }
}
