import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

import type { TeamManifest } from "../../types/team.js";
import type { AgentTemplate } from "../../types/agent.js";
import { AgentForgeSession, type SessionConfig } from "../../orchestrator/session.js";

async function invokeAction(options: {
  agent: string;
  task: string;
  loop?: boolean;
  budget?: string;
}): Promise<void> {
  const { agent: agentName, task } = options;
  const agentforgeDir = join(process.cwd(), ".agentforge");
  const teamPath = join(agentforgeDir, "team.yaml");

  // --loop notice (Sprint 2 placeholder)
  if (options.loop) {
    console.log(
      "[loop mode: use --loop flag once control-loop.ts ships in Sprint 2]",
    );
    return;
  }

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

  // Find the requested agent (case-insensitive, slug-aware match)
  const match = allAgents.find(
    (a) =>
      a.toLowerCase() === agentName.toLowerCase() ||
      a.toLowerCase().replace(/\s+/g, "-") === agentName.toLowerCase(),
  );

  if (!match) {
    console.error(`Agent "${agentName}" not found in the current team.`);
    console.error(`Available agents: ${allAgents.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  // Load agent YAML from .agentforge/agents/{agent-name}.yaml
  const filename = match.toLowerCase().replace(/\s+/g, "-") + ".yaml";
  const agentPath = join(agentforgeDir, "agents", filename);

  let agentTemplate: AgentTemplate | null = null;
  try {
    const raw = await readFile(agentPath, "utf-8");
    agentTemplate = yaml.load(raw) as AgentTemplate;
  } catch {
    console.error(
      `Agent config not found at ${agentPath}. Run 'agentforge forge' to generate agent configurations.`,
    );
    process.exitCode = 1;
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      `[pending] Set the ANTHROPIC_API_KEY environment variable to run agents against the Claude API.`,
    );
    return;
  }

  // Parse optional budget
  const sessionBudgetUsd = options.budget ? parseFloat(options.budget) : 1.0;
  if (isNaN(sessionBudgetUsd) || sessionBudgetUsd <= 0) {
    console.error(`Invalid budget value: "${options.budget}". Must be a positive number.`);
    process.exitCode = 1;
    return;
  }

  // Construct SessionConfig
  const sessionConfig: SessionConfig = {
    projectRoot: process.cwd(),
    sessionBudgetUsd,
    enableReforge: false,
    enableCostAwareRouting: true,
    enableReviewEnforcement: false,
  };

  console.log(`Invoking agent: ${match}`);
  console.log(`  Model tier:  ${agentTemplate.model}`);
  console.log(`  Budget:      $${sessionBudgetUsd.toFixed(2)}`);
  console.log(`  Task:        ${task}`);
  console.log();

  let session: AgentForgeSession;
  try {
    session = await AgentForgeSession.create(sessionConfig);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to create session: ${message}`);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await session.runAgent(agentTemplate, task, {});

    console.log("--- Response ---");
    console.log(result.content);

    const summary = await session.end();

    console.log("\n--- Usage ---");
    console.log(`  Input tokens:  ${result.inputTokens.toLocaleString()}`);
    console.log(`  Output tokens: ${result.outputTokens.toLocaleString()}`);
    console.log(`  Model used:    ${result.modelUsed}`);
    if (result.escalated) {
      console.log(`  Escalated:     yes`);
    }

    console.log("\n--- Cost Summary ---");
    console.log(`  Session ID:    ${summary.sessionId}`);
    console.log(`  Total spent:   $${summary.totalSpentUsd.toFixed(6)}`);
    console.log(`  Agent runs:    ${summary.totalAgentRuns}`);
    console.log(`  Budget:        $${sessionBudgetUsd.toFixed(2)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nAgent invocation failed: ${message}`);
    // Still attempt to end the session to write the cost artifact
    try {
      await session.end();
    } catch {
      // Best-effort
    }
    process.exitCode = 1;
  }
}

export default function registerInvokeCommand(program: Command): void {
  program
    .command("invoke")
    .description("Invoke a specific agent using the v3 AgentForgeSession runtime")
    .requiredOption("--agent <agent>", "Name of the agent to invoke")
    .requiredOption("--task <task>", "Task description")
    .option("--loop", "Enable control-loop mode (Sprint 2)")
    .option("--budget <usd>", "Maximum USD spend for this session (default: 1.00)")
    .action(invokeAction);
}
