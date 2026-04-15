import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';

interface TeamAgents {
  strategic?: string[];
  implementation?: string[];
  quality?: string[];
  utility?: string[];
  [category: string]: string[] | undefined;
}

interface TeamManifest {
  name: string;
  forged_at: string;
  project_hash: string;
  agents: TeamAgents;
  model_routing: {
    opus: string[];
    sonnet: string[];
    haiku: string[];
  };
  delegation_graph: Record<string, string[]>;
}

interface AgentTemplate {
  name: string;
  model: 'opus' | 'sonnet' | 'haiku';
  version: string;
  description?: string;
  skills?: string[];
  collaboration?: {
    can_delegate_to?: string[];
    reports_to?: string | null;
  };
}

export async function showGeneratedTeam(
  projectRoot: string,
  options: { verbose?: boolean } = {},
): Promise<number> {
  const manifest = await loadTeamManifest(projectRoot);
  if (!manifest) {
    console.log('No agents configured yet. Run `agentforge team forge` first.');
    return 0;
  }

  console.log('Current Team Composition');
  console.log('='.repeat(40));
  console.log(`  Team: ${manifest.name}`);
  console.log(`  Forged: ${manifest.forged_at}`);
  console.log(`  Hash: ${manifest.project_hash}`);

  for (const category of ['strategic', 'implementation', 'quality', 'utility']) {
    const agents = manifest.agents[category] ?? [];
    if (agents.length === 0) continue;

    console.log(`\n  ${category.charAt(0).toUpperCase() + category.slice(1)}:`);
    for (const agent of agents) {
      console.log(`    - ${agent} (${modelForAgent(manifest, agent)})`);
    }
  }

  if (!options.verbose) {
    return 0;
  }

  const agentsDir = join(projectRoot, '.agentforge', 'agents');
  console.log('\n--- Detailed Agent Info ---');

  for (const agentName of allAgents(manifest)) {
    const filename = `${agentName.toLowerCase().replace(/\s+/g, '-')}.yaml`;
    const agentPath = join(agentsDir, filename);

    try {
      const raw = await readFile(agentPath, 'utf-8');
      const agent = yaml.load(raw) as AgentTemplate;
      console.log(`\n  ${agent.name} (v${agent.version})`);
      console.log(`    Model: ${agent.model}`);
      console.log(`    Description: ${agent.description ?? '(none)'}`);
      if ((agent.skills ?? []).length > 0) {
        console.log(`    Skills: ${agent.skills!.join(', ')}`);
      }
      if ((agent.collaboration?.can_delegate_to ?? []).length > 0) {
        console.log(`    Delegates to: ${agent.collaboration!.can_delegate_to!.join(', ')}`);
      }
      if (agent.collaboration?.reports_to) {
        console.log(`    Reports to: ${agent.collaboration.reports_to}`);
      }
    } catch {
      console.log(`\n  ${agentName}: (config not found)`);
    }
  }

  console.log('\n--- Delegation Graph ---');
  for (const [from, targets] of Object.entries(manifest.delegation_graph)) {
    if (targets.length > 0) {
      console.log(`  ${from} -> ${targets.join(', ')}`);
    }
  }

  return 0;
}

async function loadTeamManifest(projectRoot: string): Promise<TeamManifest | null> {
  const teamPath = join(projectRoot, '.agentforge', 'team.yaml');
  try {
    const raw = await readFile(teamPath, 'utf-8');
    return yaml.load(raw) as TeamManifest;
  } catch {
    return null;
  }
}

function allAgents(manifest: TeamManifest): string[] {
  return [
    ...(manifest.agents.strategic ?? []),
    ...(manifest.agents.implementation ?? []),
    ...(manifest.agents.quality ?? []),
    ...(manifest.agents.utility ?? []),
  ];
}

function modelForAgent(manifest: TeamManifest, agentName: string): string {
  if (manifest.model_routing.opus.includes(agentName)) return 'opus';
  if (manifest.model_routing.sonnet.includes(agentName)) return 'sonnet';
  if (manifest.model_routing.haiku.includes(agentName)) return 'haiku';
  return 'unknown';
}
