/**
 * SpeakerSelector — Evaluates conditional delegation edges against the
 * current ProgressLedger to determine which agent should act next.
 *
 * Used by the orchestrator to implement conditional routing based on
 * runtime state (confidence, loop detection, ledger fields, etc.).
 */

import type {
  ProgressLedger,
  ConditionalDelegationGraph,
  EdgeCondition,
  DelegationEdge,
} from "../types/orchestration.js";
import type { AgentTemplate } from "../types/agent.js";

// ---------------------------------------------------------------------------
// SpeakerSelector
// ---------------------------------------------------------------------------

export class SpeakerSelector {
  /**
   * Determine which agent should speak next.
   *
   * Algorithm:
   * 1. Look up outgoing edges from `ledger.next_speaker` in the graph.
   * 2. Evaluate each edge's condition against the current ledger.
   * 3. Return the first edge whose condition passes.
   * 4. Fall back to `ledger.next_speaker` if no conditions match.
   * 5. Return `null` if `ledger.next_speaker` is also null.
   *
   * @param ledger   Current task progress state.
   * @param graph    Conditional delegation graph (edges may have conditions).
   * @param agents   Available agent templates (used for future capability checks).
   */
  selectNextSpeaker(
    ledger: ProgressLedger,
    graph: ConditionalDelegationGraph,
    agents: AgentTemplate[],
  ): string | null {
    const currentSpeaker = ledger.next_speaker;

    if (!currentSpeaker) return null;

    const edges: DelegationEdge[] = graph[currentSpeaker] ?? [];

    for (const edge of edges) {
      if (!edge.condition) {
        // Unconditional edge — always fires
        return edge.to;
      }
      if (this.evaluateCondition(edge.condition, ledger)) {
        return edge.to;
      }
    }

    // No edge matched — fall back to the ledger's designated next speaker
    return currentSpeaker;
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private evaluateCondition(
    condition: EdgeCondition,
    ledger: ProgressLedger,
  ): boolean {
    const value = this.resolveField(condition.field, ledger);

    switch (condition.operator) {
      case "equals":
        return value === condition.value;
      case "not-equals":
        return value !== condition.value;
      case "greater-than":
        return typeof value === "number" &&
          typeof condition.value === "number" &&
          value > condition.value;
      case "less-than":
        return typeof value === "number" &&
          typeof condition.value === "number" &&
          value < condition.value;
      case "contains":
        if (typeof value === "string" && typeof condition.value === "string") {
          return value.includes(condition.value);
        }
        if (Array.isArray(value) && typeof condition.value === "string") {
          return value.includes(condition.value);
        }
        return false;
      default:
        return false;
    }
  }

  /**
   * Resolves a dot-notation field path against the ledger object.
   *
   * Supports top-level fields only (e.g. "confidence", "is_in_loop",
   * "current_step") — nested paths are not yet needed.
   */
  private resolveField(field: string, ledger: ProgressLedger): unknown {
    return (ledger as unknown as Record<string, unknown>)[field];
  }
}
