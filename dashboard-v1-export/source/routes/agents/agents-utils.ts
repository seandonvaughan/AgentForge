/**
 * Shared types and pure utilities for the /agents route.
 *
 * Extracted so both +page.server.ts (SSR) and +page.svelte (browser) can
 * import without triggering SvelteKit's "don't import server files into
 * browser bundles" guard.
 */

export interface AgentListItem {
  agentId: string;
  name: string;
  model: 'opus' | 'sonnet' | 'haiku';
  description: string | null;
  role: string | null;
  /** Organisational team grouping (e.g. "strategic", "runtime", "quality"). */
  team: string | null;
  /** Invocation effort tier from YAML ("max" | "high" | "medium" | "low"). */
  effort: string | null;
}

/**
 * Pure filter predicate for the agents list page.
 *
 * Extracted from the Svelte `$derived` so it can be unit-tested without a
 * component harness. This is the exact logic used in +page.svelte's filtered
 * derived store — keep both in sync when the filter requirements change.
 *
 * @param agent       - The agent to test.
 * @param search      - Case-insensitive substring search across name/description/team.
 * @param filterModel - Model tier filter ('', 'opus', 'sonnet', 'haiku').
 * @param filterTeam  - Team filter ('' = all, '__unassigned__' = null-team agents,
 *                      other string = exact team name match).
 */
export function matchesAgentFilter(
  agent: AgentListItem,
  search: string,
  filterModel: '' | 'opus' | 'sonnet' | 'haiku',
  filterTeam: string,
): boolean {
  const q = search.toLowerCase();
  const label = (agent.name ?? agent.agentId ?? '').toLowerCase();
  const desc = (agent.description ?? '').toLowerCase();
  const teamStr = (agent.team ?? '').toLowerCase();

  const nameMatch = !q || label.includes(q) || desc.includes(q) || teamStr.includes(q);
  const modelMatch = filterModel === '' || agent.model === filterModel;
  // '__unassigned__' matches agents whose team is null/undefined/empty.
  // A plain string matches agents whose team exactly equals the filter value.
  // Empty string ('') matches all agents (no filter active).
  const teamMatch =
    filterTeam === '' ||
    (filterTeam === '__unassigned__' ? !agent.team : agent.team === filterTeam);

  return nameMatch && modelMatch && teamMatch;
}
