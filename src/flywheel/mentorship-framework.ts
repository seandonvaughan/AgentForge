/**
 * MentorshipFramework — v4.6 P1-6
 *
 * Pairs opus-tier mentor agents with haiku-tier mentees, tracks structured
 * reviews, and computes mentee progress including trend and promotion readiness.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface MentorshipPairing {
  mentorAgentId: string;
  menteeAgentId: string;
  skillFocus: string;
  pairingDate: string;
  reviewCount: number;
}

export interface MentorshipReview {
  reviewId: string;
  pairingId: string;
  mentorAgentId: string;
  menteeAgentId: string;
  sprintId: string;
  strengths: string[];
  improvements: string[];
  overallScore: number;
  promotes: boolean;
  reviewedAt: string;
}

export interface MenteeProgress {
  menteeAgentId: string;
  averageScore: number;
  reviewCount: number;
  improvementTrend: 'improving' | 'stable' | 'declining';
  promotionRecommended: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _pairingCounter = 0;

function generatePairingId(): string {
  _pairingCounter += 1;
  return `pairing-${Date.now()}-${_pairingCounter}`;
}

// ---------------------------------------------------------------------------
// MentorshipFramework
// ---------------------------------------------------------------------------

export class MentorshipFramework {
  private pairings = new Map<string, MentorshipPairing>();
  private reviews: MentorshipReview[] = [];

  // -------------------------------------------------------------------------
  // Pairings
  // -------------------------------------------------------------------------

  createPairing(pairing: MentorshipPairing): string {
    const pairingId = generatePairingId();
    this.pairings.set(pairingId, { ...pairing });
    return pairingId;
  }

  getPairing(pairingId: string): MentorshipPairing | null {
    const pairing = this.pairings.get(pairingId);
    return pairing ? { ...pairing } : null;
  }

  getPairings(mentorAgentId?: string): MentorshipPairing[] {
    const all = [...this.pairings.values()].map((p) => ({ ...p }));
    if (mentorAgentId !== undefined) {
      return all.filter((p) => p.mentorAgentId === mentorAgentId);
    }
    return all;
  }

  // -------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------

  submitReview(review: MentorshipReview): void {
    this.reviews.push({ ...review });

    // Increment reviewCount on the pairing
    const pairing = this.pairings.get(review.pairingId);
    if (pairing) {
      pairing.reviewCount += 1;
    }
  }

  getReviews(filter?: { menteeAgentId?: string; sprintId?: string }): MentorshipReview[] {
    let result = this.reviews.map((r) => ({ ...r }));
    if (filter?.menteeAgentId !== undefined) {
      result = result.filter((r) => r.menteeAgentId === filter.menteeAgentId);
    }
    if (filter?.sprintId !== undefined) {
      result = result.filter((r) => r.sprintId === filter.sprintId);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Progress
  // -------------------------------------------------------------------------

  getMenteeProgress(menteeAgentId: string): MenteeProgress | null {
    const menteeReviews = this.reviews
      .filter((r) => r.menteeAgentId === menteeAgentId)
      .sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));

    if (menteeReviews.length === 0) return null;

    const reviewCount = menteeReviews.length;
    const averageScore =
      menteeReviews.reduce((sum, r) => sum + r.overallScore, 0) / reviewCount;

    // Improvement trend: compare latest vs earliest among last 3 reviews
    let improvementTrend: MenteeProgress['improvementTrend'] = 'stable';
    if (menteeReviews.length >= 3) {
      const last3 = menteeReviews.slice(-3);
      const earliest = last3[0]!.overallScore;
      const latest = last3[last3.length - 1]!.overallScore;
      if (latest > earliest) {
        improvementTrend = 'improving';
      } else if (latest < earliest) {
        improvementTrend = 'declining';
      }
    }

    // Promotion recommended: last 2+ reviews all have promotes=true
    let promotionRecommended = false;
    if (menteeReviews.length >= 2) {
      const last2 = menteeReviews.slice(-2);
      promotionRecommended = last2.every((r) => r.promotes);
    }

    return {
      menteeAgentId,
      averageScore,
      reviewCount,
      improvementTrend,
      promotionRecommended,
    };
  }

  getAllMenteeProgress(): MenteeProgress[] {
    const menteeIds = new Set(this.reviews.map((r) => r.menteeAgentId));
    const results: MenteeProgress[] = [];
    for (const menteeId of menteeIds) {
      const progress = this.getMenteeProgress(menteeId);
      if (progress) results.push(progress);
    }
    return results;
  }
}
