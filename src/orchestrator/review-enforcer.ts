/**
 * ReviewEnforcer — Gates unreviewed strategic agent outputs.
 *
 * Strategic agents (category === "strategic") require a human or designated
 * reviewer agent to approve their output before it propagates. All other
 * categories auto-approve.
 *
 * This implements a lightweight approval circuit-breaker for high-stakes
 * decisions without requiring external infrastructure.
 */

import type { AgentTemplate } from "../types/agent.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of an enforcement check. */
export interface ReviewDecision {
  /** Whether the output is approved to proceed. */
  approved: boolean;
  /** The reviewer assigned (undefined when auto-approved). */
  reviewerName?: string;
  /** Optional feedback from the reviewer (undefined when auto-approved). */
  feedback?: string;
}

// ---------------------------------------------------------------------------
// ReviewEnforcer
// ---------------------------------------------------------------------------

export class ReviewEnforcer {
  /**
   * Enforce the review gate for an agent's output.
   *
   * Rules:
   * - Non-strategic agents (implementation, quality, utility): auto-approve.
   * - Strategic agents with no reviewers: auto-approve (no gate to enforce).
   * - Strategic agents with reviewers: block and assign the first reviewer.
   *
   * @param output     The agent's output text to be reviewed.
   * @param agent      The agent that produced the output.
   * @param reviewers  Ordered list of reviewer names to assign.
   * @returns ReviewDecision indicating whether to proceed and who reviews.
   */
  async enforceReview(
    output: string,
    agent: AgentTemplate,
    reviewers: string[],
  ): Promise<ReviewDecision> {
    const isStrategic = agent.category === "strategic";

    if (!isStrategic) {
      return { approved: true };
    }

    if (reviewers.length === 0) {
      // Strategic agent but no reviewers configured — auto-approve with warning context
      return { approved: true };
    }

    // Block and assign first available reviewer
    return {
      approved: false,
      reviewerName: reviewers[0],
      feedback: undefined,
    };
  }
}
