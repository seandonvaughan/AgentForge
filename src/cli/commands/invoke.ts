import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

import type { TeamManifest } from "../../types/team.js";
import type { AgentTemplate } from "../../types/agent.js";

async function invokeAction(
  agentName: string,
  taskParts: string[],
): Promise<void> {
  const task = taskParts.join(" ");
  const agentforgeDir = join(process.cwd(), ".agentforge");
  const teamPath = join(agentforgeDir, "team.yaml");

  // Load team manifest
  let manifest: TeamManifest;
  try {
    const raw = await readFile(teamPath, "utf-8");
    manifest = yaml.load(raw) as TeamManifest;
  } catch {
    console.error("No agent team found. Run 'agentforge forge' first.");
    process.exitCode = 1;
    return;
  }

  // Collect all agent names
  const allAgents = [
    ...manifest.agents.strategic,
    ...manifest.agents.implementation,
    ...manifest.agents.quality,
    ...manifest.agents.utility,
  ];

  // Find the requested agent (case-insensitive match)
  const match = allAgents.find(
    (a) => a.toLowerCase() === agentName.toLowerCase() ||
           a.toLowerCase().replace(/\s+/g, "-") === agentName.toLowerCase(),
  );

  if (!match) {
    console.error(`Agent "${agentName}" not found in the current team.`);
    console.error(`Available agents: ${allAgents.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  // Load agent config
  const filename = match.toLowerCase().replace(/\s+/g, "-") + ".yaml";
  const agentPath = join(agentforgeDir, "agents", filename);

  let agent: AgentTemplate | null = null;
  try {
    const raw = await readFile(agentPath, "utf-8");
    agent = yaml.load(raw) as AgentTemplate;
  } catch {
    // Agent config missing but agent is in manifest — proceed with basic info
  }

  // Determine model tier
  let model = "sonnet";
  if (manifest.model_routing.opus.includes(match)) model = "opus";
  else if (manifest.model_routing.haiku.includes(match)) model = "haiku";

  console.log(`Invoking agent: ${match}`);
  console.log(`  Model tier: ${model}`);
  console.log(`  Task: ${task}`);

  if (agent) {
    console.log(`  Skills: ${agent.skills.length > 0 ? agent.skills.join(", ") : "(none)"}`);
    if (agent.collaboration.can_delegate_to.length > 0) {
      console.log(`  Can delegate to: ${agent.collaboration.can_delegate_to.join(", ")}`);
    }
  }

  console.log(`\n[pending] Agent invocation queued. API integration will be available in a future release.`);
}

export default function registerInvokeCommand(program: Command): void {
  program
    .command("invoke")
    .description("Invoke a specific agent")
    .argument("<agent>", "Name of the agent to invoke")
    .argument("<task...>", "Task description")
    .action(invokeAction);
}
