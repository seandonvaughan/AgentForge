/**
 * Bridge Builder -- creates cross-domain connections between agent teams.
 *
 * When multiple domain packs are active, agents in different domains need
 * explicit bridges so delegation and communication can cross domain
 * boundaries.  This module provides:
 *
 * - `buildBridges`   -- identify cross-domain connection points and create
 *                       Bridge objects.
 * - `mergeTopology`  -- combine per-domain teams with bridges into a
 *                       unified CrossDomainTeam.
 */

import type {
  Bridge,
  CrossDomainTeam,
  DomainTeam,
} from "../types/collaboration.js";
import type { DelegationGraph } from "../types/team.js";

// ---------------------------------------------------------------------------
// buildBridges
// ---------------------------------------------------------------------------

/**
 * Identify cross-domain connection points and create explicit bridges.
 *
 * Logic:
 * 1. For every pair of domain leads, create a bridge between them
 *    (strategic agents that share cross-domain concerns).
 * 2. If the delegation graph contains an agent that delegates to leads
 *    in multiple domains (e.g. a project-manager), create a coordinator
 *    bridge from that agent to all domain leads.
 *
 * @param domainTeams     - Per-domain team configurations keyed by domain name.
 * @param delegationGraph - Directed graph of who can delegate to whom.
 * @returns Array of Bridge objects representing cross-domain connections.
 */
export function buildBridges(
  domainTeams: Record<string, DomainTeam>,
  delegationGraph: DelegationGraph,
): Bridge[] {
  const domainEntries = Object.entries(domainTeams).map(([domainName, team]) => ({
    domainName,
    team,
  }));

  // Single domain -- no bridges needed
  if (domainEntries.length < 2) {
    return [];
  }

  const bridges: Bridge[] = [];
  const seen = new Set<string>();

  const leads = domainEntries.map(({ domainName, team }) => ({
    domainName,
    lead: team.lead,
  }));

  // 1. Lead-to-lead bridges
  for (let i = 0; i < leads.length; i++) {
    const left = leads[i];
    if (!left) continue;
    for (let j = i + 1; j < leads.length; j++) {
      const right = leads[j];
      if (!right) continue;

      const key = `${left.lead}->${right.lead}`;
      if (!seen.has(key)) {
        seen.add(key);
        bridges.push({
          from: left.lead,
          to: right.lead,
          reason: `Cross-domain coordination between ${left.domainName} and ${right.domainName} leads`,
        });
      }
    }
  }

  // 2. Coordinator bridges -- agents in the delegation graph that
  //    delegate to leads across multiple domains.
  const leadsSet = new Set<string>(leads.map(({ lead }) => lead));

  for (const [agent, delegatesTo] of Object.entries(delegationGraph)) {
    // Skip agents that are already domain leads
    if (leadsSet.has(agent)) continue;

    const targetLeads = delegatesTo.filter((t) => leadsSet.has(t));
    if (targetLeads.length >= 2) {
      const sortedTargets = [...targetLeads].sort();
      const key = `${agent}->[${sortedTargets.join(",")}]`;
      if (!seen.has(key)) {
        seen.add(key);
        bridges.push({
          from: agent,
          to: sortedTargets,
          reason: "Coordinator needs visibility into all domains",
        });
      }
    }
  }

  return bridges;
}

// ---------------------------------------------------------------------------
// mergeTopology
// ---------------------------------------------------------------------------

/**
 * Combine per-domain teams with bridges into a unified CrossDomainTeam.
 *
 * @param domainTeams - Per-domain team configurations keyed by domain name.
 * @param bridges     - Cross-domain bridge connections.
 * @param coordinator - Name of the central coordinator agent.
 * @returns A complete CrossDomainTeam configuration.
 */
export function mergeTopology(
  domainTeams: Record<string, DomainTeam>,
  bridges: Bridge[],
  coordinator: string,
): CrossDomainTeam {
  // Collect shared utilities -- utilities appearing in two or more domains.
  const utilityCounts = new Map<string, number>();
  for (const team of Object.values(domainTeams)) {
    for (const util of team.utilities) {
      utilityCounts.set(util, (utilityCounts.get(util) ?? 0) + 1);
    }
  }

  const sharedUtilities: string[] = [];
  for (const [util, count] of utilityCounts) {
    if (count >= 2) {
      sharedUtilities.push(util);
    }
  }

  return {
    topology: "hub-and-spoke",
    coordinator,
    teams: domainTeams,
    bridges,
    shared_utilities: sharedUtilities,
  };
}
