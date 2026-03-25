import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

import type { TeamManifest } from "../../types/team.js";
import type { AgentTemplate } from "../../types/agent.js";

/** Simple keyword-based routing score for an agent against a task. */
function scoreAgent(
  agent: AgentTemplate,
  task: string,
): { score: number; reasons: string[] } {
  const taskLower = task.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  // Check keyword triggers
  for (const keyword of agent.triggers.keywords) {
    if (taskLower.includes(keyword.toLowerCase())) {
      score += 30;
      reasons.push(`Keyword match: "${keyword}"`);
    }
  }

  // Check file pattern triggers
  for (const pattern of agent.triggers.file_patterns) {
    const ext = pattern.replace(/^\*\./, "").replace(/\*/g, "");
    if (ext && taskLower.includes(ext)) {
      score += 15;
      reasons.push(`File pattern hint: "${pattern}"`);
    }
  }

  // Check skill relevance
  for (const skill of agent.skills) {
    if (taskLower.includes(skill.toLowerCase())) {
      score += 25;
      reasons.push(`Skill match: "${skill}"`);
    }
  }

  // Check description relevance
  const descWords = agent.description.toLowerCase().split(/\s+/);
  const taskWords = taskLower.split(/\s+/);
  const overlap = taskWords.filter((w) => w.length > 3 && descWords.includes(w));
  if (overlap.length > 0) {
    score += overlap.length * 5;
    reasons.push(`Description overlap: ${overlap.join(", ")}`);
  }

  // Baseline score so every agent has some chance
  score += 5;

  return { score, reasons };
}

async function delegateAction(taskParts: string[]): Promise<void> {
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

  const allAgents = [
    ...manifest.agents.strategic,
    ...manifest.agents.implementation,
    ...manifest.agents.quality,
    ...manifest.agents.utility,
  ];

  if (allAgents.length === 0) {
    console.error("No agents available to handle this task. Run 'agentforge forge' first.");
    process.exitCode = 1;
    return;
  }

  console.log(`Task: ${task}`);
  console.log(`Routing across ${allAgents.length} agents...\n`);

  // Load agent configs and score them
  const scored: { name: string; model: string; score: number; reasons: string[] }[] = [];

  for (const agentName of allAgents) {
    const filename = agentName.toLowerCase().replace(/\s+/g, "-") + ".yaml";
    const agentPath = join(agentforgeDir, "agents", filename);

    let model = "sonnet";
    if (manifest.model_routing.opus.includes(agentName)) model = "opus";
    else if (manifest.model_routing.haiku.includes(agentName)) model = "haiku";

    try {
      const raw = await readFile(agentPath, "utf-8");
      const agent = yaml.load(raw) as AgentTemplate;
      const { score, reasons } = scoreAgent(agent, task);
      scored.push({ name: agentName, model, score, reasons });
    } catch {
      // Agent config not found — give baseline score
      scored.push({ name: agentName, model, score: 5, reasons: ["Baseline (no config found)"] });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Normalize to confidence percentages
  const maxScore = scored[0].score;

  console.log("Routing Decision:");
  console.log("-".repeat(50));

  for (let i = 0; i < Math.min(scored.length, 5); i++) {
    const entry = scored[i];
    const confidence = maxScore > 0 ? Math.round((entry.score / maxScore) * 100) : 0;
    const marker = i === 0 ? " <-- recommended" : "";

    console.log(`  ${i + 1}. ${entry.name} (${entry.model}) — confidence: ${confidence}%${marker}`);
    for (const reason of entry.reasons) {
      console.log(`       ${reason}`);
    }
  }

  if (scored.length > 5) {
    console.log(`  ... and ${scored.length - 5} more agents`);
  }

  const best = scored[0];
  console.log(`\nBest match: ${best.name} (${best.model} tier)`);
  console.log(`Use 'agentforge invoke ${best.name.toLowerCase().replace(/\s+/g, "-")} ${task}' to run this agent.`);
}

export default function registerDelegateCommand(program: Command): void {
  program
    .command("delegate")
    .description("Route a task to the best agent automatically")
    .argument("<task...>", "Task description")
    .action(delegateAction);
}
