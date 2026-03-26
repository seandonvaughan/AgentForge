import type { Command } from "commander";
import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { TeamModeSession } from "../../orchestrator/team-mode-session.js";
import type { TeamModeConfig, AutonomyLevel, TeamSessionConfig } from "../../types/team-mode.js";
import type { TeamManifest } from "../../types/team.js";
import type { AgentTemplate } from "../../types/agent.js";

let activeSession: TeamModeSession | null = null;

export function getActiveSession(): TeamModeSession | null {
  return activeSession;
}

async function activateAction(options: {
  mode?: string;
  budget?: string;
}): Promise<void> {
  try {
    if (activeSession?.getState() === "active") {
      console.error("Team mode is already active. Run `deactivate` first.");
      process.exitCode = 1;
      return;
    }

    const projectRoot = process.cwd();
    const teamPath = path.join(projectRoot, ".agentforge", "team.yaml");

    let manifest: TeamManifest;
    try {
      const raw = await fs.readFile(teamPath, "utf-8");
      manifest = yaml.load(raw) as TeamManifest;
    } catch {
      console.error("No team found. Run `agentforge forge` or `agentforge genesis` first.");
      process.exitCode = 1;
      return;
    }

    const agentsDir = path.join(projectRoot, ".agentforge", "agents");
    const templates = new Map<string, AgentTemplate>();
    const allAgents = Object.values(manifest.agents).flat();

    for (const agentName of allAgents) {
      const agentPath = path.join(agentsDir, `${agentName}.yaml`);
      try {
        const raw = await fs.readFile(agentPath, "utf-8");
        templates.set(agentName, yaml.load(raw) as AgentTemplate);
      } catch {
        // Agent template not found — skip with warning
        console.warn(`  Warning: no template for ${agentName}`);
      }
    }

    const budget = options.budget ? parseFloat(options.budget) : 5.0;

    const sessionConfig: TeamSessionConfig = {
      projectRoot,
      sessionBudgetUsd: budget,
      enableReforge: false,
      enableCostAwareRouting: true,
      enableReviewEnforcement: false,
    };

    const config: TeamModeConfig = {
      sessionConfig,
      teamManifest: manifest,
      agentTemplates: templates,
    };

    const autonomyOverride = options.mode as AutonomyLevel | undefined;
    const session = new TeamModeSession(config);
    await session.activate(autonomyOverride);
    activeSession = session;

    console.log(`\n  Team Mode ACTIVE`);
    console.log(`  --------------------------------`);
    console.log(`  Team:      ${manifest.name}`);
    console.log(`  Session:   ${session.getSessionId().slice(0, 8)}`);
    console.log(`  Autonomy:  ${session.getAutonomyLevel()}`);
    console.log(`  Budget:    $${budget.toFixed(2)}`);
    console.log(`  Agents:    ${allAgents.length}`);
    console.log(`\n  Give tasks naturally or use @agent-name for direct messages.`);
    console.log(`  Run \`deactivate\` to exit team mode.\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Activation failed: ${message}`);
    process.exitCode = 1;
  }
}

export default function registerActivateCommand(program: Command): void {
  program
    .command("activate")
    .description("Enter team mode — persistent multi-agent session")
    .option("--mode <level>", "Autonomy level: full, supervised, or guided")
    .option("--budget <usd>", "Session budget in USD (default: 5.00)")
    .action(activateAction);
}
