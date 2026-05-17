#!/usr/bin/env node
/**
 * Run the agent-driven forge pipeline against THIS project (AgentForge itself).
 *
 * Wires the building blocks directly (bypassing forgeTeamAgentDriven so we can
 * use per-recon-agent runtimes with their own model + system prompts):
 *
 *   Phase A: 5 recon agents (Sonnet/Haiku each with its own prompt)
 *   Phase B: synthesizeTeam (Opus reads recon JSONs + corpus → writes prompts)
 *   Phase C: validateTeam (deterministic fact-check)
 *   Phase D: buildRoutingIndex
 *
 * Output:
 *   .agentforge/forge/recon/<agentId>.json    — per-recon agent
 *   .agentforge/forge/team-plan.json          — Opus synthesis output
 *   .agentforge/forge/validation-report.json  — Phase C findings
 *   .agentforge/agents/<id>.yaml              — new agent YAMLs (REPLACES old)
 *   .claude/agents/<id>.md                    — CC-native agent files
 *   .agentforge/team.yaml                     — new team manifest
 *   .agentforge/routing-index.json            — capability-tag router input
 *
 * Snapshot preserved at .agentforge/agents-pre-v22-forge/ for diffing.
 *
 * Usage: node scripts/run-agent-driven-forge.mjs
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

// ── Imports from @agentforge/core (already built) ─────────────────────────
const core = await import("../packages/core/dist/index.js");
const {
  buildSourceCorpus,
  synthesizeTeam,
  validateTeam,
} = core;

// recon-runner + routing-index are in subpaths
const { runReconAgent } = await import(
  "../packages/core/dist/team/engine/builder/recon/recon-runner.js"
);
const { buildRoutingIndex } = await import(
  "../packages/core/dist/autonomous/routing/routing-index.js"
);
const { AgentRuntime } = await import(
  "../packages/core/dist/agent-runtime/agent-runtime.js"
);

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build an AgentRuntime configured for a specific agentId/model/systemPrompt. */
function makeRuntime({ agentId, name, model, systemPrompt, effort }) {
  const config = {
    agentId,
    name,
    model,
    systemPrompt,
    workspaceId: "agentforge-self-forge",
    ...(effort ? { effort } : {}),
  };
  return new AgentRuntime(config);
}

/** Load a recon agent's prompt markdown. */
async function loadReconPrompt(agentId) {
  const promptPath = join(
    projectRoot,
    "packages/core/dist/team/engine/builder/recon/prompts",
    `${agentId}.md`,
  );
  return readFile(promptPath, "utf8").catch(() =>
    // Fall back to src/ if dist/ doesn't ship the prompts
    readFile(
      join(
        projectRoot,
        "packages/core/src/team/engine/builder/recon/prompts",
        `${agentId}.md`,
      ),
      "utf8",
    ),
  );
}

/** Load the synthesis prompt. */
async function loadSynthesisPrompt() {
  const p = join(
    projectRoot,
    "packages/core/src/team/engine/builder/synthesis-prompt.md",
  );
  return readFile(p, "utf8");
}

/** Wrap an AgentRuntime as the lightweight recon-runner interface. */
function asReconRuntime(runtime) {
  return {
    async run(_agentId, task, _opts) {
      const result = await runtime.run({ task });
      return { ...result, response: result.response };
    },
  };
}

// ── Recon agent definitions ────────────────────────────────────────────────

const RECON_AGENTS = [
  { id: "code-archaeologist",   model: "sonnet" },
  { id: "dep-graph-analyst",    model: "haiku"  },
  { id: "convention-detective", model: "haiku"  },
  { id: "domain-mapper",        model: "sonnet" },
  { id: "failure-historian",    model: "sonnet" },
];

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  console.log("=".repeat(72));
  console.log("AgentForge — first real Opus-driven forge against self");
  console.log("=".repeat(72));
  console.log(`projectRoot: ${projectRoot}`);

  // 1. Build source corpus
  console.log("\n[1/4] Building source corpus...");
  const corpus = await buildSourceCorpus({
    projectRoot,
    maxChars: 120_000, // conservative
  });
  console.log(
    `  -> ${corpus.files.length} files, ${corpus.totalChars.toLocaleString()} chars`,
  );
  console.log(`     subsystems: ${corpus.subsystemsSampled.join(", ")}`);
  console.log(`     skipped: ${corpus.skipped} (over budget or duplicate)`);

  // 2. Phase A — Recon (parallel) — RESUME from disk if cached
  console.log("\n[2/4] Running 5 recon agents (parallel; cached entries skip)...");
  const reconStartedAt = Date.now();
  const reconResults = {};
  await Promise.all(
    RECON_AGENTS.map(async ({ id, model }) => {
      // Resume path: skip the API call if a validated artifact exists
      const cachedPath = join(
        projectRoot,
        ".agentforge/forge/recon",
        `${id}.json`,
      );
      try {
        const cached = JSON.parse(await readFile(cachedPath, "utf8"));
        if (cached.status === "validated" && cached.parsed) {
          reconResults[id] = cached.parsed;
          console.log(`  -> ${id} CACHED (skipping API call)`);
          return;
        }
      } catch {
        // no cache — fall through to live call
      }

      const prompt = await loadReconPrompt(id);
      const runtime = makeRuntime({
        agentId: `forge-recon-${id}`,
        name: id,
        model,
        systemPrompt: prompt,
      });
      const adapter = asReconRuntime(runtime);
      try {
        const result = await runReconAgent({
          agentId: id,
          prompt,
          inputs: {
            projectRoot,
            sourceCorpus: corpus.files,
          },
          runtime: adapter,
          projectRoot,
          model,
        });
        reconResults[id] = result;
        console.log(`  -> ${id} OK (model=${model})`);
      } catch (err) {
        console.error(`  -> ${id} FAILED: ${err.message}`);
        throw err;
      }
    }),
  );
  console.log(`  total recon time: ${((Date.now() - reconStartedAt)/1000).toFixed(1)}s`);

  // Map recon outputs to the synthesis schema's expected shape
  const reconBundle = {
    subsystems: reconResults["code-archaeologist"],
    dependencies: reconResults["dep-graph-analyst"],
    conventions: reconResults["convention-detective"],
    domain: reconResults["domain-mapper"],
    history: reconResults["failure-historian"],
  };

  // 3. Phase B — Opus synthesis
  console.log("\n[3/4] Running Opus synthesis...");
  const synthStartedAt = Date.now();
  const synthesisPrompt = await loadSynthesisPrompt();
  const synthesisRuntime = makeRuntime({
    agentId: "forge-synthesizer",
    name: "synthesizer",
    model: "opus",
    systemPrompt: synthesisPrompt,
    effort: "xhigh",
  });
  let teamPlan;
  try {
    teamPlan = await synthesizeTeam({
      reconResults: reconBundle,
      sourceCorpus: corpus.files,
      projectRoot,
      runtime: synthesisRuntime,
      model: "opus",
    });
    console.log(
      `  -> synthesized ${teamPlan.agents.length} agents in ${((Date.now()-synthStartedAt)/1000).toFixed(1)}s`,
    );
  } catch (err) {
    console.error(`  -> synthesis FAILED: ${err.message}`);
    if (err.cause) console.error(`     cause: ${err.cause}`);
    throw err;
  }

  // 4. Phase C — Validation
  console.log("\n[4/4] Running validator...");
  const validation = await validateTeam({ projectRoot });
  console.log(`  -> valid=${validation.valid}, ${validation.findings.length} findings`);
  for (const f of validation.findings.slice(0, 10)) {
    console.log(`     [${f.severity}] ${f.agentId}: ${f.check} — ${f.message.slice(0, 100)}`);
  }
  if (validation.findings.length > 10) {
    console.log(`     ... (${validation.findings.length - 10} more)`);
  }

  // 5. Phase D — Routing index
  console.log("\n[5/5] Building routing index...");
  const routingPath = join(projectRoot, ".agentforge/routing-index.json");
  const routing = buildRoutingIndex({
    agentsDir: join(projectRoot, ".agentforge/agents"),
    teamPath: join(projectRoot, ".agentforge/team.yaml"),
    outputPath: routingPath,
  });
  console.log(`  -> indexed ${routing.agents.length} agents`);
  console.log(`     written to: ${routingPath}`);

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(72));
  console.log(`DONE in ${totalSec}s`);
  console.log("=".repeat(72));
}

main().catch((err) => {
  console.error("\nFORGE FAILED:", err);
  process.exit(1);
});
