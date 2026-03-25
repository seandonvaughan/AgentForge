import { promises as fs } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { reforgeTeam, applyDiff, logReforge, migrateV1ToV2 } from "../../reforge/index.js";
import { ReforgeEngine } from "../../reforge/reforge-engine.js";

// ---------------------------------------------------------------------------
// reforge (original v2 behavior)
// ---------------------------------------------------------------------------

async function reforgeAction(options: {
  autoApply?: boolean;
  upgrade?: boolean;
}): Promise<void> {
  // --upgrade: migrate v1 team.yaml to v2 format and exit
  if (options.upgrade) {
    console.log("Upgrading team to v2 format...");
    try {
      await migrateV1ToV2(process.cwd());
      console.log("Team upgraded to v2 format successfully.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error upgrading team: ${message}`);
      process.exitCode = 1;
    }
    return;
  }

  console.log("Re-analyzing project for changes...\n");

  try {
    const diff = await reforgeTeam(process.cwd());

    // Display the diff
    console.log(`Summary: ${diff.summary}`);

    if (
      diff.agents_added.length === 0 &&
      diff.agents_removed.length === 0 &&
      diff.agents_modified.length === 0 &&
      diff.model_changes.length === 0
    ) {
      console.log("\nYour team is up to date. No reforge needed.");
      return;
    }

    if (diff.agents_added.length > 0) {
      console.log(`\nAgents to add:`);
      for (const agent of diff.agents_added) {
        console.log(`  + ${agent}`);
      }
    }

    if (diff.agents_removed.length > 0) {
      console.log(`\nAgents to remove:`);
      for (const agent of diff.agents_removed) {
        console.log(`  - ${agent}`);
      }
    }

    if (diff.agents_modified.length > 0) {
      console.log(`\nAgents modified:`);
      for (const mod of diff.agents_modified) {
        console.log(`  ~ ${mod.name}`);
        for (const change of mod.changes) {
          console.log(`      ${change}`);
        }
      }
    }

    if (diff.model_changes.length > 0) {
      console.log(`\nModel tier changes:`);
      for (const mc of diff.model_changes) {
        console.log(`  ${mc.agent}: ${mc.from} -> ${mc.to}`);
      }
    }

    if (diff.skill_updates.length > 0) {
      console.log(`\nSkill updates:`);
      for (const su of diff.skill_updates) {
        if (su.added.length > 0) {
          console.log(`  ${su.agent} gained: ${su.added.join(", ")}`);
        }
        if (su.removed.length > 0) {
          console.log(`  ${su.agent} lost: ${su.removed.join(", ")}`);
        }
      }
    }

    if (options.autoApply) {
      console.log("\nApplying changes...");
      await applyDiff(process.cwd(), diff);
      await logReforge(process.cwd(), diff);
      console.log("Reforge complete.");
    } else {
      console.log("\nRun with --auto-apply to apply these changes.");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error during reforge: ${message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// reforge apply <proposal-id> (Phase 3f)
// ---------------------------------------------------------------------------

async function applyProposalAction(
  proposalId: string,
  options: { yes?: boolean },
): Promise<void> {
  const proposalsDir = path.join(process.cwd(), ".agentforge", "reforge-proposals");

  try {
    const files = await fs.readdir(proposalsDir);
    const match = files.find((f) => f.includes(proposalId));

    if (!match) {
      console.error(`No proposal found matching ID "${proposalId}".`);
      console.log(`\nAvailable proposals in ${proposalsDir}:`);
      for (const f of files.filter((f) => f.endsWith(".md"))) {
        console.log(`  ${f}`);
      }
      process.exitCode = 1;
      return;
    }

    const content = await fs.readFile(path.join(proposalsDir, match), "utf-8");
    console.log("=== Structural Reforge Proposal ===\n");
    console.log(content);

    if (!options.yes) {
      console.log("\nTo apply this proposal, re-run with --yes flag:");
      console.log(`  agentforge reforge apply ${proposalId} --yes`);
      return;
    }

    // Mark proposal as applied by renaming
    const appliedName = match.replace(".md", ".applied.md");
    await fs.rename(
      path.join(proposalsDir, match),
      path.join(proposalsDir, appliedName),
    );
    console.log(`\nProposal applied and archived as: ${appliedName}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ENOENT")) {
      console.log("No reforge proposals found. Directory does not exist yet.");
    } else {
      console.error(`Error: ${message}`);
      process.exitCode = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// reforge list (Phase 3f)
// ---------------------------------------------------------------------------

async function listAction(): Promise<void> {
  const cwd = process.cwd();
  const proposalsDir = path.join(cwd, ".agentforge", "reforge-proposals");
  const overridesDir = path.join(cwd, ".agentforge", "agent-overrides");

  // List structural proposals
  console.log("=== Structural Proposals ===\n");
  try {
    const proposals = await fs.readdir(proposalsDir);
    const pending = proposals.filter((f) => f.endsWith(".md") && !f.includes(".applied"));
    const applied = proposals.filter((f) => f.includes(".applied"));

    if (pending.length === 0 && applied.length === 0) {
      console.log("  (none)\n");
    } else {
      for (const f of pending) {
        console.log(`  [PENDING] ${f}`);
      }
      for (const f of applied) {
        console.log(`  [APPLIED] ${f}`);
      }
      console.log();
    }
  } catch {
    console.log("  (no proposals directory)\n");
  }

  // List active overrides
  console.log("=== Active Agent Overrides ===\n");
  try {
    const overrides = await fs.readdir(overridesDir);
    const jsonFiles = overrides.filter((f) => f.endsWith(".json"));

    if (jsonFiles.length === 0) {
      console.log("  (none)\n");
    } else {
      const engine = new ReforgeEngine(cwd);
      for (const f of jsonFiles) {
        const agentName = f.replace(".json", "");
        const override = await engine.loadOverride(agentName);
        if (override) {
          const mutTypes = override.mutations.map((m) => m.type).join(", ");
          console.log(`  ${agentName} v${override.version} — ${mutTypes} (${override.appliedAt})`);
        }
      }
      console.log();
    }
  } catch {
    console.log("  (no overrides directory)\n");
  }
}

// ---------------------------------------------------------------------------
// reforge rollback <agent> (Phase 3f)
// ---------------------------------------------------------------------------

async function rollbackAction(agentName: string): Promise<void> {
  const engine = new ReforgeEngine(process.cwd());

  try {
    const current = await engine.loadOverride(agentName);
    if (!current) {
      console.error(`No override found for agent "${agentName}".`);
      process.exitCode = 1;
      return;
    }

    console.log(`Current override for ${agentName}: v${current.version}`);
    await engine.rollback(agentName);

    const after = await engine.loadOverride(agentName);
    console.log(`Rolled back to: v${after?.version ?? 0}`);
    console.log("Rollback complete.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Rollback failed: ${message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// reforge status (Phase 3f)
// ---------------------------------------------------------------------------

async function statusAction(): Promise<void> {
  const cwd = process.cwd();
  const overridesDir = path.join(cwd, ".agentforge", "agent-overrides");

  console.log("=== Reforge Status ===\n");

  try {
    const files = await fs.readdir(overridesDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    if (jsonFiles.length === 0) {
      console.log("No agent overrides active. System is running base templates.");
      return;
    }

    const engine = new ReforgeEngine(cwd);
    let totalMutations = 0;

    for (const f of jsonFiles) {
      const agentName = f.replace(".json", "");
      const override = await engine.loadOverride(agentName);
      if (!override) continue;

      totalMutations += override.mutations.length;

      console.log(`${agentName}:`);
      console.log(`  Version:    ${override.version}/5`);
      console.log(`  Applied:    ${override.appliedAt}`);
      console.log(`  Session:    ${override.sessionId}`);
      console.log(`  Rollback:   ${override.previousVersion ? "available" : "none"}`);
      console.log(`  Mutations:`);
      for (const m of override.mutations) {
        console.log(`    - [${m.type}] ${m.field}: ${JSON.stringify(m.oldValue)} → ${JSON.stringify(m.newValue)}`);
      }
      if (override.systemPromptPreamble) {
        const preview = override.systemPromptPreamble.slice(0, 80);
        console.log(`  Preamble:   "${preview}${override.systemPromptPreamble.length > 80 ? "..." : ""}"`);
      }
      if (override.modelTierOverride) {
        console.log(`  Model:      → ${override.modelTierOverride}`);
      }
      if (override.effortOverride) {
        console.log(`  Effort:     → ${override.effortOverride}`);
      }
      console.log();
    }

    console.log(`Total: ${jsonFiles.length} agent(s) with ${totalMutations} mutation(s) active.`);
  } catch {
    console.log("No agent overrides directory found. System is running base templates.");
  }
}

// ---------------------------------------------------------------------------
// Command Registration
// ---------------------------------------------------------------------------

export default function registerReforgeCommand(program: Command): void {
  const reforgeCmd = program
    .command("reforge")
    .description("Re-analyze project and update agent team");

  // Original reforge (v2-compatible)
  reforgeCmd
    .option("--auto-apply", "Apply changes without review")
    .option("--upgrade", "Migrate v1 team to v2 format without running full reforge")
    .action(reforgeAction);

  // Phase 3f: apply structural proposal
  reforgeCmd
    .command("apply <proposal-id>")
    .description("Review and apply a structural reforge proposal")
    .option("--yes", "Apply without confirmation prompt")
    .action(applyProposalAction);

  // Phase 3f: list proposals and overrides
  reforgeCmd
    .command("list")
    .description("List pending proposals and active overrides")
    .action(listAction);

  // Phase 3f: rollback agent override
  reforgeCmd
    .command("rollback <agent>")
    .description("Rollback an agent override to its previous version")
    .action(rollbackAction);

  // Phase 3f: show reforge status
  reforgeCmd
    .command("status")
    .description("Show reforge override status for all agents")
    .action(statusAction);
}
