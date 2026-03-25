import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runGenesis, discover, getInterviewQuestions } from "../../genesis/index.js";
import { runInteractiveInterview } from "../../genesis/interview-runner.js";
import type { DomainId } from "../../types/domain.js";
import type { TeamManifest } from "../../types/team.js";

async function genesisAction(options: {
  interview?: boolean;
  domains?: string;
  yes?: boolean;
}): Promise<void> {
  console.log("Starting Genesis workflow...\n");

  try {
    // Step 1: Discovery to check if interview should run
    const discoveryResult = await discover(process.cwd());
    let shouldInterview = options.interview || discoveryResult.state === "empty";

    // Parse comma-separated domains if provided
    const parsedDomains: DomainId[] | undefined = options.domains
      ? options.domains
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean) as DomainId[]
      : undefined;

    // Step 2: Run interview if needed
    let interviewAnswers: Record<string, string> = {};
    if (shouldInterview) {
      console.log("Running project interview...\n");
      const questions = getInterviewQuestions(discoveryResult.state);
      interviewAnswers = await runInteractiveInterview(questions);
      console.log("\n");
    }

    // Step 3: Run Genesis workflow
    const result = await runGenesis({
      projectRoot: process.cwd(),
      interview: options.interview,
      domains: parsedDomains,
      answers: interviewAnswers,
    });

    const { manifest, domains } = result;

    // Step 4: Print formatted team summary
    printTeamSummary(manifest, domains);

    // Step 5: Approval gate (unless --yes was passed)
    if (!options.yes) {
      const rl = createInterface({ input, output });
      const approved = await getApproval(rl);
      rl.close();

      if (!approved) {
        console.log("Cancelled. No files written.");
        process.exit(0);
      }
    }

    console.log("\nGenesis complete. Team written to .agentforge/team.yaml");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error during genesis: ${message}`);
    process.exitCode = 1;
  }
}

/**
 * Print a formatted summary of the proposed team.
 */
function printTeamSummary(
  manifest: TeamManifest,
  domains: DomainId[],
): void {
  const opusCount = manifest.model_routing.opus.length;
  const sonnetCount = manifest.model_routing.sonnet.length;
  const haikuCount = manifest.model_routing.haiku.length;
  const totalAgents = opusCount + sonnetCount + haikuCount;

  console.log("  PROPOSED TEAM — " + manifest.name);
  console.log("  ───────────────────────────────────\n");

  console.log("  Domains activated: " + domains.join(", ") + "\n");

  if (manifest.agents.strategic && manifest.agents.strategic.length > 0) {
    console.log("  STRATEGIC (Opus)");
    for (const agent of manifest.agents.strategic) {
      console.log(`    ${agent}   —`);
    }
    console.log();
  }

  if (manifest.agents.implementation && manifest.agents.implementation.length > 0) {
    console.log("  IMPLEMENTATION (Sonnet)");
    for (const agent of manifest.agents.implementation) {
      console.log(`    ${agent}   —`);
    }
    console.log();
  }

  if (manifest.agents.utility && manifest.agents.utility.length > 0) {
    console.log("  UTILITY (Haiku)");
    for (const agent of manifest.agents.utility) {
      console.log(`    ${agent}   —`);
    }
    console.log();
  }

  if (manifest.agents.quality && manifest.agents.quality.length > 0) {
    console.log("  QUALITY");
    for (const agent of manifest.agents.quality) {
      console.log(`    ${agent}   —`);
    }
    console.log();
  }

  console.log(`  ${totalAgents} agents total  |  ${opusCount} Opus · ${sonnetCount} Sonnet · ${haikuCount} Haiku\n`);
}

/**
 * Prompt the user for approval to write the team.
 * Returns true if user approves, false otherwise.
 */
async function getApproval(rl: ReturnType<typeof createInterface>): Promise<boolean> {
  console.log("  Write this team to .agentforge/?");
  console.log("    y  Accept and write");
  console.log("    n  Cancel (nothing is written)");

  const answer = await rl.question("  > ");
  const normalized = answer.toLowerCase().trim();
  return normalized === "y" || normalized === "yes";
}

export default function registerGenesisCommand(program: Command): void {
  program
    .command("genesis")
    .description("Start from an idea and build an optimized agent team")
    .option("--interview", "Force interview mode even if project files exist")
    .option("--domains <domains>", "Comma-separated list of domains to activate (e.g. software,business)")
    .option("--yes", "Skip approval gate (useful for CI/CD)")
    .action(genesisAction);
}
