import type { Command } from 'commander';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface RoutingIndexAgent {
  id: string;
  capability_tags: string[];
  owns_subsystems: string[];
  tier: string;
}

interface RoutingIndex {
  agents: RoutingIndexAgent[];
}

interface SkillCoverageEntry {
  capability_tag: string;
  num_skills: number;
  agents_routed: number;
  is_bare: boolean;
  mean_step_score?: number;
}

export function registerSkillsCoverageCommand(program: Command): void {
  const skills = program
    .command('skills')
    .description('Inspect skill coverage and routing');

  skills
    .command('coverage')
    .description('Show capability tag to skills mapping and coverage analysis')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--json', 'Output as JSON')
    .action(async (commandOptions: {
      projectRoot: string;
      json?: boolean;
    }) => {
      try {
        await showSkillsCoverage(commandOptions);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}

async function showSkillsCoverage(opts: {
  projectRoot: string;
  json?: boolean;
}): Promise<void> {
  const routingIndexPath = join(opts.projectRoot, '.agentforge', 'routing-index.json');
  const skillsCatalogPath = join(opts.projectRoot, 'packages', 'skills-catalog', 'skills');

  if (!existsSync(routingIndexPath)) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'routing-index.json not found', results: [] }));
    } else {
      console.log('No routing-index.json found.');
    }
    return;
  }

  const routingIndexContent = readFileSync(routingIndexPath, 'utf-8');
  const routingIndex = JSON.parse(routingIndexContent) as RoutingIndex;

  // Build capability_tag -> agent count map
  const capabilityToAgents = new Map<string, number>();
  for (const agent of routingIndex.agents) {
    for (const tag of agent.capability_tags) {
      capabilityToAgents.set(tag, (capabilityToAgents.get(tag) ?? 0) + 1);
    }
  }

  // Count skills per capability_tag
  const capabilityToSkills = new Map<string, number>();
  if (existsSync(skillsCatalogPath)) {
    const skillDirs = readdirSync(skillsCatalogPath).filter(name => {
      const stat = statSync(join(skillsCatalogPath, name));
      return stat.isDirectory();
    });

    for (const skillDir of skillDirs) {
      const skillPath = join(skillsCatalogPath, skillDir);
      const skillFiles = readdirSync(skillPath).filter(f => f.endsWith('.md'));

      for (const file of skillFiles) {
        // Extract capability tag from filename (e.g., af-tdd.md -> tdd)
        const match = file.match(/^af-([a-z0-9\-]+)\.md$/);
        if (match) {
          const tag = match[1];
          capabilityToSkills.set(tag, (capabilityToSkills.get(tag) ?? 0) + 1);
        }
      }
    }
  }

  // Build results
  const allTags = new Set<string>();
  capabilityToAgents.forEach((_, tag) => allTags.add(tag));
  capabilityToSkills.forEach((_, tag) => allTags.add(tag));

  const results: SkillCoverageEntry[] = [];
  for (const tag of Array.from(allTags).sort()) {
    const numSkills = capabilityToSkills.get(tag) ?? 0;
    const agentsRouted = capabilityToAgents.get(tag) ?? 0;
    const isBare = numSkills < 2 && (agentsRouted === 0 || numSkills === 0);

    results.push({
      capability_tag: tag,
      num_skills: numSkills,
      agents_routed: agentsRouted,
      is_bare: isBare,
    });
  }

  if (opts.json) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    if (results.length === 0) {
      console.log('No capability tags found.');
      return;
    }

    console.log('Skill Coverage Report');
    console.log('');
    console.log('Capability Tag                                    | Skills | Agents | Status');
    console.log('-'.repeat(80));

    const bareCapabilities = results.filter(r => r.is_bare);

    for (const entry of results) {
      const status = entry.is_bare ? 'BARE' : 'covered';
      const tagPadded = entry.capability_tag.padEnd(48);
      console.log(`${tagPadded} | ${String(entry.num_skills).padStart(6)} | ${String(entry.agents_routed).padStart(6)} | ${status}`);
    }

    console.log('');
    console.log(`Total capability tags: ${results.length}`);
    console.log(`Bare tags (no skills or <2 skills + unrouted): ${bareCapabilities.length}`);

    if (bareCapabilities.length > 0) {
      console.log('');
      console.log('Bare capabilities (T2 flywheel input):');
      for (const bare of bareCapabilities) {
        console.log(`  - ${bare.capability_tag} (${bare.num_skills} skills, ${bare.agents_routed} agents)`);
      }
    }
  }
}
