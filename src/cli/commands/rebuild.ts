import type { Command } from "commander";
import { reforgeTeam, applyDiff, logReforge, migrateV1ToV2 } from "../../reforge/index.js";

// ---------------------------------------------------------------------------
// rebuild (team re-scan)
// ---------------------------------------------------------------------------

async function rebuildAction(options: {
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
      console.log("\nYour team is up to date. No rebuild needed.");
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
      console.log("Rebuild complete.");
    } else {
      console.log("\nRun with --auto-apply to apply these changes.");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error during rebuild: ${message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Command Registration
// ---------------------------------------------------------------------------

export default function registerRebuildCommand(program: Command): void {
  program
    .command("rebuild")
    .description("Re-scan project and update agent team")
    .option("--auto-apply", "Apply changes without review")
    .option("--upgrade", "Migrate v1 team to v2 format without running full rebuild")
    .action(rebuildAction);
}
