/**
 * Topology Selector -- chooses the best collaboration topology
 * for a project based on heuristics from spec Section 4.1.
 *
 * The decision table:
 *
 * | Condition                                          | Topology      |
 * |----------------------------------------------------|---------------|
 * | User specifies corporate/org structure              | hierarchy     |
 * | Multiple domains, cross-functional dual reporting   | matrix        |
 * | Multiple domains, independent workstreams           | hub-and-spoke |
 * | Single domain, > 5 agents                           | hierarchy     |
 * | Single domain, <= 5 agents                          | flat          |
 */

import type { ProjectBrief } from "../types/analysis.js";
import type { DomainId } from "../types/domain.js";
import type { CollaborationTemplate } from "../types/collaboration.js";

/**
 * Select the best topology type for a project.
 *
 * @param brief      - The universal project brief.
 * @param domains    - Active domain identifiers.
 * @param agentCount - Total number of agents that will be deployed.
 * @returns The topology type string.
 */
export function selectTopology(
  brief: ProjectBrief,
  domains: DomainId[],
  agentCount: number,
): CollaborationTemplate["type"] {
  // 1. User specifies corporate/org structure -> hierarchy
  if (brief.constraints.structure === "corporate") {
    return "hierarchy";
  }

  const isMultiDomain = domains.length > 1;

  // 2. Multiple domains with dual-reporting signal -> matrix
  if (isMultiDomain && brief.constraints.reporting === "dual") {
    return "matrix";
  }

  // 3. Multiple domains -> hub-and-spoke
  if (isMultiDomain) {
    return "hub-and-spoke";
  }

  // 4. Single domain, > 5 agents -> hierarchy
  if (agentCount > 5) {
    return "hierarchy";
  }

  // 5. Single domain, <= 5 agents -> flat
  return "flat";
}
