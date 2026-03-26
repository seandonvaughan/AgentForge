/**
 * MultiReviewer — v4.2 P1-10
 *
 * Extends review routing with multiple reviewers per document,
 * consensus rules (all-approve or majority), and inline comments.
 */

import { randomUUID } from "node:crypto";

export type ConsensusRule = "all" | "majority";

export interface InlineComment {
  commentId: string;
  reviewerId: string;
  filePath: string;
  lineNumber: number;
  content: string;
  createdAt: string;
  resolved: boolean;
}

export interface ReviewerVerdict {
  reviewerId: string;
  verdict: "approve" | "request_changes" | "block";
  comments: InlineComment[];
  submittedAt: string;
}

export interface MultiReviewRecord {
  reviewId: string;
  documentId: string;
  documentTitle: string;
  authorAgentId: string;
  reviewers: string[];
  consensusRule: ConsensusRule;
  verdicts: ReviewerVerdict[];
  status: "pending" | "in_review" | "decided" | "approved" | "rejected";
  createdAt: string;
  updatedAt: string;
}

export class MultiReviewer {
  private reviews = new Map<string, MultiReviewRecord>();

  submitForReview(input: {
    documentId: string;
    documentTitle: string;
    authorAgentId: string;
    reviewers: string[];
    consensusRule?: ConsensusRule;
  }): MultiReviewRecord {
    const now = new Date().toISOString();
    const record: MultiReviewRecord = {
      reviewId: randomUUID(),
      documentId: input.documentId,
      documentTitle: input.documentTitle,
      authorAgentId: input.authorAgentId,
      reviewers: [...input.reviewers],
      consensusRule: input.consensusRule ?? "all",
      verdicts: [],
      status: "in_review",
      createdAt: now,
      updatedAt: now,
    };
    this.reviews.set(record.reviewId, record);
    return this.clone(record);
  }

  submitVerdict(
    reviewId: string,
    reviewerId: string,
    verdict: "approve" | "request_changes" | "block",
    comments: Omit<InlineComment, "commentId" | "createdAt" | "resolved">[] = [],
  ): MultiReviewRecord {
    const record = this.require(reviewId);
    if (!record.reviewers.includes(reviewerId)) {
      throw new Error(`"${reviewerId}" is not a reviewer for "${reviewId}"`);
    }
    if (record.verdicts.some((v) => v.reviewerId === reviewerId)) {
      throw new Error(`"${reviewerId}" already submitted a verdict for "${reviewId}"`);
    }

    const now = new Date().toISOString();
    record.verdicts.push({
      reviewerId,
      verdict,
      comments: comments.map((c) => ({
        ...c,
        commentId: randomUUID(),
        createdAt: now,
        resolved: false,
      })),
      submittedAt: now,
    });
    record.updatedAt = now;

    // Check if consensus is reached
    if (record.verdicts.length === record.reviewers.length) {
      record.status = "decided";
      const approved = this.checkConsensus(record);
      record.status = approved ? "approved" : "rejected";
    }

    return this.clone(record);
  }

  resolveComment(reviewId: string, commentId: string): void {
    const record = this.require(reviewId);
    for (const v of record.verdicts) {
      const comment = v.comments.find((c) => c.commentId === commentId);
      if (comment) {
        comment.resolved = true;
        record.updatedAt = new Date().toISOString();
        return;
      }
    }
    throw new Error(`Comment "${commentId}" not found in review "${reviewId}"`);
  }

  getReview(reviewId: string): MultiReviewRecord | null {
    const r = this.reviews.get(reviewId);
    return r ? this.clone(r) : null;
  }

  getPendingReviewers(reviewId: string): string[] {
    const record = this.require(reviewId);
    const submitted = new Set(record.verdicts.map((v) => v.reviewerId));
    return record.reviewers.filter((r) => !submitted.has(r));
  }

  getUnresolvedComments(reviewId: string): InlineComment[] {
    const record = this.require(reviewId);
    return record.verdicts
      .flatMap((v) => v.comments)
      .filter((c) => !c.resolved)
      .map((c) => ({ ...c }));
  }

  private checkConsensus(record: MultiReviewRecord): boolean {
    const approvals = record.verdicts.filter((v) => v.verdict === "approve").length;
    if (record.consensusRule === "all") {
      return approvals === record.reviewers.length;
    }
    // majority
    return approvals > record.reviewers.length / 2;
  }

  private require(reviewId: string): MultiReviewRecord {
    const r = this.reviews.get(reviewId);
    if (!r) throw new Error(`Review "${reviewId}" not found`);
    return r;
  }

  private clone(record: MultiReviewRecord): MultiReviewRecord {
    return {
      ...record,
      reviewers: [...record.reviewers],
      verdicts: record.verdicts.map((v) => ({
        ...v,
        comments: v.comments.map((c) => ({ ...c })),
      })),
    };
  }
}
