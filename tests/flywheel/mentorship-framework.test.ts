import { describe, it, expect, beforeEach } from 'vitest';
import {
  MentorshipFramework,
  type MentorshipPairing,
  type MentorshipReview,
} from '../../src/flywheel/mentorship-framework.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePairing(overrides: Partial<MentorshipPairing> = {}): MentorshipPairing {
  return {
    mentorAgentId: 'opus-agent-1',
    menteeAgentId: 'haiku-agent-1',
    skillFocus: 'code-review',
    pairingDate: '2026-03-01',
    reviewCount: 0,
    ...overrides,
  };
}

let _reviewCounter = 0;
function makeReview(pairingId: string, overrides: Partial<MentorshipReview> = {}): MentorshipReview {
  _reviewCounter += 1;
  return {
    reviewId: `review-${_reviewCounter}`,
    pairingId,
    mentorAgentId: 'opus-agent-1',
    menteeAgentId: 'haiku-agent-1',
    sprintId: 'sprint-46',
    strengths: ['good structure'],
    improvements: ['needs better error handling'],
    overallScore: 0.7,
    promotes: false,
    reviewedAt: `2026-03-0${_reviewCounter}T00:00:00Z`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MentorshipFramework', () => {
  let framework: MentorshipFramework;

  beforeEach(() => {
    _reviewCounter = 0;
    framework = new MentorshipFramework();
  });

  // -------------------------------------------------------------------------
  // Pairings
  // -------------------------------------------------------------------------

  describe('createPairing', () => {
    it('returns a non-empty string ID', () => {
      const id = framework.createPairing(makePairing());
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('returns unique IDs for different pairings', () => {
      const id1 = framework.createPairing(makePairing({ menteeAgentId: 'haiku-1' }));
      const id2 = framework.createPairing(makePairing({ menteeAgentId: 'haiku-2' }));
      expect(id1).not.toBe(id2);
    });

    it('stores the pairing data retrievable by ID', () => {
      const id = framework.createPairing(makePairing({ skillFocus: 'testing' }));
      const pairing = framework.getPairing(id);
      expect(pairing?.skillFocus).toBe('testing');
    });
  });

  describe('getPairing', () => {
    it('returns null for unknown ID', () => {
      expect(framework.getPairing('nonexistent')).toBeNull();
    });

    it('returns a copy so mutations do not affect internal state', () => {
      const id = framework.createPairing(makePairing());
      const pairing = framework.getPairing(id)!;
      pairing.skillFocus = 'tampered';
      expect(framework.getPairing(id)?.skillFocus).toBe('code-review');
    });
  });

  describe('getPairings', () => {
    it('returns all pairings when no filter provided', () => {
      framework.createPairing(makePairing({ menteeAgentId: 'haiku-1' }));
      framework.createPairing(makePairing({ menteeAgentId: 'haiku-2' }));
      expect(framework.getPairings()).toHaveLength(2);
    });

    it('filters by mentorAgentId', () => {
      framework.createPairing(makePairing({ mentorAgentId: 'opus-1', menteeAgentId: 'haiku-1' }));
      framework.createPairing(makePairing({ mentorAgentId: 'opus-2', menteeAgentId: 'haiku-2' }));
      framework.createPairing(makePairing({ mentorAgentId: 'opus-1', menteeAgentId: 'haiku-3' }));
      const result = framework.getPairings('opus-1');
      expect(result).toHaveLength(2);
      expect(result.every((p) => p.mentorAgentId === 'opus-1')).toBe(true);
    });

    it('returns empty array when mentorAgentId has no pairings', () => {
      framework.createPairing(makePairing({ mentorAgentId: 'opus-1' }));
      expect(framework.getPairings('opus-999')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------

  describe('submitReview', () => {
    it('stores a review and retrieves it via getReviews', () => {
      const pairingId = framework.createPairing(makePairing());
      framework.submitReview(makeReview(pairingId));
      expect(framework.getReviews()).toHaveLength(1);
    });

    it('increments reviewCount on the associated pairing', () => {
      const pairingId = framework.createPairing(makePairing());
      framework.submitReview(makeReview(pairingId));
      framework.submitReview(makeReview(pairingId));
      expect(framework.getPairing(pairingId)?.reviewCount).toBe(2);
    });
  });

  describe('getReviews with filters', () => {
    let pairingId: string;

    beforeEach(() => {
      pairingId = framework.createPairing(makePairing());
      framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', sprintId: 'sprint-46' }));
      framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-2', sprintId: 'sprint-46' }));
      framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', sprintId: 'sprint-47' }));
    });

    it('filters by menteeAgentId', () => {
      const result = framework.getReviews({ menteeAgentId: 'haiku-1' });
      expect(result).toHaveLength(2);
      expect(result.every((r) => r.menteeAgentId === 'haiku-1')).toBe(true);
    });

    it('filters by sprintId', () => {
      const result = framework.getReviews({ sprintId: 'sprint-46' });
      expect(result).toHaveLength(2);
    });

    it('returns all reviews when no filter provided', () => {
      expect(framework.getReviews()).toHaveLength(3);
    });

    it('combines menteeAgentId and sprintId filters', () => {
      const result = framework.getReviews({ menteeAgentId: 'haiku-1', sprintId: 'sprint-47' });
      expect(result).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Mentee Progress
  // -------------------------------------------------------------------------

  describe('getMenteeProgress', () => {
    it('returns null when mentee has no reviews', () => {
      expect(framework.getMenteeProgress('haiku-unknown')).toBeNull();
    });

    it('calculates averageScore correctly from multiple reviews', () => {
      const pairingId = framework.createPairing(makePairing());
      framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.6, reviewedAt: '2026-03-01T00:00:00Z' }));
      framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.8, reviewedAt: '2026-03-02T00:00:00Z' }));
      const progress = framework.getMenteeProgress('haiku-1')!;
      expect(progress.averageScore).toBeCloseTo(0.7, 5);
    });

    it('sets reviewCount to the number of reviews', () => {
      const pairingId = framework.createPairing(makePairing());
      framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', reviewedAt: '2026-03-01T00:00:00Z' }));
      framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', reviewedAt: '2026-03-02T00:00:00Z' }));
      framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', reviewedAt: '2026-03-03T00:00:00Z' }));
      expect(framework.getMenteeProgress('haiku-1')?.reviewCount).toBe(3);
    });

    describe('improvementTrend', () => {
      it('is "improving" when latest score > earliest among last 3 reviews', () => {
        const pairingId = framework.createPairing(makePairing());
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.5, reviewedAt: '2026-03-01T00:00:00Z' }));
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.6, reviewedAt: '2026-03-02T00:00:00Z' }));
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.8, reviewedAt: '2026-03-03T00:00:00Z' }));
        expect(framework.getMenteeProgress('haiku-1')?.improvementTrend).toBe('improving');
      });

      it('is "declining" when latest score < earliest among last 3 reviews', () => {
        const pairingId = framework.createPairing(makePairing());
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.9, reviewedAt: '2026-03-01T00:00:00Z' }));
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.7, reviewedAt: '2026-03-02T00:00:00Z' }));
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.5, reviewedAt: '2026-03-03T00:00:00Z' }));
        expect(framework.getMenteeProgress('haiku-1')?.improvementTrend).toBe('declining');
      });

      it('is "stable" when scores are equal across last 3 reviews', () => {
        const pairingId = framework.createPairing(makePairing());
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.7, reviewedAt: '2026-03-01T00:00:00Z' }));
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.6, reviewedAt: '2026-03-02T00:00:00Z' }));
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.7, reviewedAt: '2026-03-03T00:00:00Z' }));
        expect(framework.getMenteeProgress('haiku-1')?.improvementTrend).toBe('stable');
      });

      it('is "stable" when mentee has only 1 review (fewer than 3)', () => {
        const pairingId = framework.createPairing(makePairing());
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.8, reviewedAt: '2026-03-01T00:00:00Z' }));
        expect(framework.getMenteeProgress('haiku-1')?.improvementTrend).toBe('stable');
      });

      it('is "stable" when mentee has exactly 2 reviews', () => {
        const pairingId = framework.createPairing(makePairing());
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.5, reviewedAt: '2026-03-01T00:00:00Z' }));
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.9, reviewedAt: '2026-03-02T00:00:00Z' }));
        expect(framework.getMenteeProgress('haiku-1')?.improvementTrend).toBe('stable');
      });

      it('uses last 3 reviews only (ignores older ones for trend)', () => {
        const pairingId = framework.createPairing(makePairing());
        // Oldest 2: high scores (would look improving if included)
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.3, reviewedAt: '2026-02-01T00:00:00Z' }));
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.4, reviewedAt: '2026-02-15T00:00:00Z' }));
        // Last 3: declining
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.9, reviewedAt: '2026-03-01T00:00:00Z' }));
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.7, reviewedAt: '2026-03-02T00:00:00Z' }));
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', overallScore: 0.5, reviewedAt: '2026-03-03T00:00:00Z' }));
        expect(framework.getMenteeProgress('haiku-1')?.improvementTrend).toBe('declining');
      });
    });

    describe('promotionRecommended', () => {
      it('is true when last 2 reviews both have promotes=true', () => {
        const pairingId = framework.createPairing(makePairing());
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', promotes: false, reviewedAt: '2026-03-01T00:00:00Z' }));
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', promotes: true, reviewedAt: '2026-03-02T00:00:00Z' }));
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', promotes: true, reviewedAt: '2026-03-03T00:00:00Z' }));
        expect(framework.getMenteeProgress('haiku-1')?.promotionRecommended).toBe(true);
      });

      it('is false when only 1 of the last 2 reviews has promotes=true', () => {
        const pairingId = framework.createPairing(makePairing());
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', promotes: true, reviewedAt: '2026-03-01T00:00:00Z' }));
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', promotes: false, reviewedAt: '2026-03-02T00:00:00Z' }));
        expect(framework.getMenteeProgress('haiku-1')?.promotionRecommended).toBe(false);
      });

      it('is false with only 1 review regardless of promotes value', () => {
        const pairingId = framework.createPairing(makePairing());
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', promotes: true, reviewedAt: '2026-03-01T00:00:00Z' }));
        expect(framework.getMenteeProgress('haiku-1')?.promotionRecommended).toBe(false);
      });

      it('is true when all reviews have promotes=true and there are exactly 2', () => {
        const pairingId = framework.createPairing(makePairing());
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', promotes: true, reviewedAt: '2026-03-01T00:00:00Z' }));
        framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', promotes: true, reviewedAt: '2026-03-02T00:00:00Z' }));
        expect(framework.getMenteeProgress('haiku-1')?.promotionRecommended).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  // getAllMenteeProgress
  // -------------------------------------------------------------------------

  describe('getAllMenteeProgress', () => {
    it('returns empty array when no reviews have been submitted', () => {
      expect(framework.getAllMenteeProgress()).toHaveLength(0);
    });

    it('returns one entry per distinct mentee', () => {
      const pairingId = framework.createPairing(makePairing());
      framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', reviewedAt: '2026-03-01T00:00:00Z' }));
      framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-2', reviewedAt: '2026-03-01T00:00:00Z' }));
      framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', reviewedAt: '2026-03-02T00:00:00Z' }));
      const all = framework.getAllMenteeProgress();
      expect(all).toHaveLength(2);
      const ids = all.map((p) => p.menteeAgentId).sort();
      expect(ids).toEqual(['haiku-1', 'haiku-2']);
    });

    it('includes correct reviewCount per mentee', () => {
      const pairingId = framework.createPairing(makePairing());
      framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', reviewedAt: '2026-03-01T00:00:00Z' }));
      framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-1', reviewedAt: '2026-03-02T00:00:00Z' }));
      framework.submitReview(makeReview(pairingId, { menteeAgentId: 'haiku-2', reviewedAt: '2026-03-01T00:00:00Z' }));
      const all = framework.getAllMenteeProgress();
      const haiku1 = all.find((p) => p.menteeAgentId === 'haiku-1')!;
      const haiku2 = all.find((p) => p.menteeAgentId === 'haiku-2')!;
      expect(haiku1.reviewCount).toBe(2);
      expect(haiku2.reviewCount).toBe(1);
    });
  });
});
