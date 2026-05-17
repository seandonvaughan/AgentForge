// packages/core/src/autonomous/routing/routing-index.ts
//
// Phase D: Routing layer — capability-tag index builder.
//
// Reads every agent YAML under .agentforge/agents/ and emits a
// .agentforge/routing-index.json that maps capability_tags + owns_subsystems
// to agent IDs so the router can do O(n) matching instead of 5-keyword
// switch-case.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoutingIndexAgent {
  id: string;
  capability_tags: string[];
  owns_subsystems: string[];
  tier: 'opus' | 'sonnet' | 'haiku';
  /** Tag-specificity weight used as tie-breaker during routing. Higher = more specific. */
  priority: number;
}

export interface RoutingIndex {
  agents: RoutingIndexAgent[];
  generated_at: string;
  team_name: string;
}

// ---------------------------------------------------------------------------
// Internal YAML parsing (intentionally lightweight — no js-yaml dep)
// ---------------------------------------------------------------------------

/**
 * A minimal YAML scalar-list reader that understands:
 *   key: [val1, val2, ...]
 *   key:
 *     - val1
 *     - val2
 * Only reads string values. Ignores nested structures.
 */
function readYamlStringList(content: string, key: string): string[] {
  // Inline list: key: [a, b, c]
  const inlineRe = new RegExp(`^${key}:\\s*\\[([^\\]\\n]*)\\]`, 'm');
  const inlineMatch = inlineRe.exec(content);
  if (inlineMatch?.[1]) {
    return inlineMatch[1]
      .split(',')
      .map((s) => s.replace(/['"]/g, '').trim())
      .filter(Boolean);
  }

  // Block list: key:\n  - val\n  - val
  const blockRe = new RegExp(`^${key}:\\s*\\n((?:[ \\t]+-[^\\n]*\\n?)*)`, 'm');
  const blockMatch = blockRe.exec(content);
  if (blockMatch?.[1]) {
    return blockMatch[1]
      .split('\n')
      .map((line) => line.replace(/^[ \t]+-\s*/, '').replace(/['"]/g, '').trim())
      .filter(Boolean);
  }

  return [];
}

function readYamlScalar(content: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*['"]?([^'"\\n]+)['"]?`, 'm');
  const match = re.exec(content);
  return match?.[1]?.trim();
}

// ---------------------------------------------------------------------------
// Tier detection
// ---------------------------------------------------------------------------

function parseTier(raw: string | undefined): 'opus' | 'sonnet' | 'haiku' {
  if (!raw) return 'sonnet';
  const t = raw.toLowerCase();
  if (t.includes('opus')) return 'opus';
  if (t.includes('haiku')) return 'haiku';
  return 'sonnet';
}

// ---------------------------------------------------------------------------
// Priority calculation
// ---------------------------------------------------------------------------

/**
 * Higher priority = more specific.
 * Agents with more capability_tags AND narrower subsystem ownership outrank
 * generalists.
 */
function computePriority(tags: string[], subsystems: string[]): number {
  const subsystemSpecificity = subsystems.reduce((acc, s) => acc + s.split('/').length, 0);
  return tags.length * 2 + subsystemSpecificity;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildRoutingIndexOptions {
  agentsDir: string;
  teamPath?: string;
  outputPath?: string;
}

/**
 * Read every .yaml under agentsDir, extract capability metadata, and
 * write routing-index.json to outputPath.
 *
 * Returns the constructed index (also written to disk if outputPath is set).
 */
export function buildRoutingIndex(opts: BuildRoutingIndexOptions): RoutingIndex {
  const { agentsDir, teamPath, outputPath } = opts;

  // Read team name from team.yaml if available
  let teamName = 'default';
  if (teamPath && existsSync(teamPath)) {
    const teamContent = readFileSync(teamPath, 'utf8');
    const parsed = readYamlScalar(teamContent, 'name');
    if (parsed) teamName = parsed;
  }

  // Collect all agent YAMLs
  const agents: RoutingIndexAgent[] = [];

  if (!existsSync(agentsDir)) {
    const index: RoutingIndex = { agents: [], generated_at: new Date().toISOString(), team_name: teamName };
    if (outputPath) writeFileSync(outputPath, JSON.stringify(index, null, 2));
    return index;
  }

  const files = readdirSync(agentsDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  for (const file of files) {
    const agentId = file.replace(/\.ya?ml$/, '');
    const filePath = join(agentsDir, file);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const capability_tags = readYamlStringList(content, 'capability_tags');
    const owns_subsystems = readYamlStringList(content, 'owns_subsystems');
    const modelRaw = readYamlScalar(content, 'model');
    const tier = parseTier(modelRaw);
    const priority = computePriority(capability_tags, owns_subsystems);

    // Include ALL agents — legacy agents get empty lists but are still indexed
    agents.push({ id: agentId, capability_tags, owns_subsystems, tier, priority });
  }

  // Sort deterministically: by priority desc, then id asc
  agents.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  const index: RoutingIndex = {
    agents,
    generated_at: new Date().toISOString(),
    team_name: teamName,
  };

  if (outputPath) {
    writeFileSync(outputPath, JSON.stringify(index, null, 2));
  }

  return index;
}
