/**
 * Handoff Manager for the AgentForge Orchestrator.
 *
 * Implements the structured handoff protocol (spec Section 11.6) that
 * prevents context loss when work transitions between agents in a
 * pipeline pattern.  Each handoff carries artifact metadata, open
 * questions, and constraints so the receiving agent has full context.
 */

import type { Handoff } from "../types/orchestration.js";

/** Result of validating a Handoff. */
export interface HandoffValidation {
  /** Whether the handoff passes all checks. */
  valid: boolean;
  /** List of validation errors (empty when valid). */
  errors: string[];
}

/**
 * Manages structured handoffs between agents.
 *
 * Tracks handoff history so any agent's participation (as sender or
 * receiver) can be queried later.
 */
export class HandoffManager {
  private readonly history: Handoff[] = [];

  /**
   * Creates a structured handoff and records it in the history.
   */
  createHandoff(
    from: string,
    to: string,
    artifact: Handoff["artifact"],
    openQuestions: string[],
    constraints: string[],
    status: Handoff["status"],
  ): Handoff {
    const handoff: Handoff = {
      from,
      to,
      artifact,
      open_questions: openQuestions,
      constraints,
      status,
    };

    this.history.push(handoff);
    return handoff;
  }

  /**
   * Builds a human-readable context string for injection into the
   * target agent's prompt.
   *
   * Includes: source agent, artifact details, open questions,
   * constraints, and completion status.
   */
  buildHandoffContext(handoff: Handoff, targetAgentName: string): string {
    const lines: string[] = [];

    lines.push(`## Handoff to ${targetAgentName}`);
    lines.push("");
    lines.push(
      `You are receiving work from **${handoff.from}**.`,
    );
    lines.push("");

    // Artifact section
    lines.push("### Artifact");
    lines.push(`- **Type:** ${handoff.artifact.type}`);
    lines.push(`- **Summary:** ${handoff.artifact.summary}`);
    lines.push(`- **Location:** ${handoff.artifact.location}`);
    lines.push(`- **Confidence:** ${handoff.artifact.confidence}`);
    lines.push(`- **Status:** ${handoff.status}`);
    lines.push("");

    // Open questions
    if (handoff.open_questions.length > 0) {
      lines.push("### Open Questions");
      for (const q of handoff.open_questions) {
        lines.push(`- ${q}`);
      }
      lines.push("");
    }

    // Constraints
    if (handoff.constraints.length > 0) {
      lines.push("### Constraints");
      for (const c of handoff.constraints) {
        lines.push(`- ${c}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Validates that a handoff has all required fields populated and
   * that values are within acceptable ranges.
   *
   * Collects all errors rather than failing on the first one.
   */
  validateHandoff(handoff: Handoff): HandoffValidation {
    const errors: string[] = [];

    if (!handoff.from) {
      errors.push("'from' is required and must not be empty");
    }

    if (!handoff.to) {
      errors.push("'to' is required and must not be empty");
    }

    if (!handoff.artifact.summary) {
      errors.push("artifact 'summary' is required and must not be empty");
    }

    if (!handoff.artifact.location) {
      errors.push("artifact 'location' is required and must not be empty");
    }

    if (
      handoff.artifact.confidence < 0 ||
      handoff.artifact.confidence > 1
    ) {
      errors.push("artifact 'confidence' must be between 0 and 1");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Returns all handoffs involving the named agent, whether as sender
   * or receiver, in creation order.
   */
  getHandoffHistory(agentName: string): Handoff[] {
    return this.history.filter(
      (h) => h.from === agentName || h.to === agentName,
    );
  }
}
