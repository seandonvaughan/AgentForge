/**
 * Tag Similarity — Jaccard-based agent tag matching for cross-agent learning
 * propagation (T2.5).
 *
 * Used by the cross-agent propagator to find which agents should receive
 * a learning originally scored for a different agent, based on overlapping
 * capability tags.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute Jaccard similarity between two sets of tags.
 *
 * Jaccard(A, B) = |A ∩ B| / |A ∪ B|
 *
 * Tags are compared case-insensitively. Returns 0 when both arrays are empty
 * (instead of NaN) to simplify downstream threshold comparisons.
 *
 * @param tagsA - Tags for agent A.
 * @param tagsB - Tags for agent B.
 * @returns     - Similarity score in [0, 1].
 */
export function tagSimilarity(tagsA: string[], tagsB: string[]): number {
  const setA = new Set(tagsA.map((t) => t.toLowerCase()));
  const setB = new Set(tagsB.map((t) => t.toLowerCase()));

  if (setA.size === 0 && setB.size === 0) return 0;

  let intersectionCount = 0;
  for (const tag of setA) {
    if (setB.has(tag)) intersectionCount++;
  }

  const unionCount = setA.size + setB.size - intersectionCount;
  return intersectionCount / unionCount;
}

// ---------------------------------------------------------------------------

/**
 * Find all agents whose capability tags overlap with `sourceAgentId`'s tags
 * at or above `threshold` (default 0.7).
 *
 * The source agent itself is excluded from the result.
 *
 * @param sourceAgentId - ID of the agent whose learnings we are propagating.
 * @param allAgents     - Full agent roster with their capability_tags arrays.
 * @param threshold     - Minimum Jaccard similarity required (default 0.7).
 * @returns             - Sorted array of agent IDs that qualify (no source).
 */
export function findRelatedAgents(
  sourceAgentId: string,
  allAgents: Array<{ id: string; capability_tags: string[] }>,
  threshold = 0.7,
): string[] {
  const sourceAgent = allAgents.find((a) => a.id === sourceAgentId);
  if (!sourceAgent) return [];

  const related: string[] = [];

  for (const agent of allAgents) {
    if (agent.id === sourceAgentId) continue;

    const sim = tagSimilarity(sourceAgent.capability_tags, agent.capability_tags);
    if (sim >= threshold) {
      related.push(agent.id);
    }
  }

  return related;
}
