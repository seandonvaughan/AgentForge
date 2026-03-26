import type { Command } from "commander";
import { SessionSerializer } from "../../orchestrator/session-serializer.js";
import { StalenessDetector } from "../../orchestrator/staleness-detector.js";

async function sessionsListAction(): Promise<void> {
  const projectRoot = process.cwd();
  const serializer = new SessionSerializer(projectRoot);
  const detector = new StalenessDetector(projectRoot);

  const sessions = await serializer.list();

  if (sessions.length === 0) {
    console.log("\n  No hibernated sessions found.\n");
    return;
  }

  const current = await detector.getCurrentCommit();

  console.log(`\n  Hibernated Sessions`);
  console.log(`  -------------------`);

  for (const session of sessions) {
    const stale = await detector.isStale(session.gitCommitAtHibernation);
    const staleMarker = stale ? " [STALE]" : "";
    const budgetRemaining = (session.sessionBudgetUsd - session.spentUsd).toFixed(2);

    console.log(`\n  ${session.sessionId.slice(0, 8)}${staleMarker}`);
    console.log(`    Autonomy:  ${session.autonomyLevel}`);
    console.log(`    Team:      ${session.teamManifest.name}`);
    console.log(`    Spent:     $${session.spentUsd.toFixed(2)} / $${session.sessionBudgetUsd.toFixed(2)} ($${budgetRemaining} remaining)`);
    console.log(`    Feed:      ${session.feedEntries.length} entries`);
    console.log(`    Saved:     ${session.hibernatedAt}`);
    if (stale) {
      console.log(`    Warning:   Codebase changed since hibernation (was ${session.gitCommitAtHibernation}, now ${current})`);
    }
  }

  console.log();
}

async function sessionsDeleteAction(sessionId: string): Promise<void> {
  const serializer = new SessionSerializer(process.cwd());
  await serializer.deleteById(sessionId);
  console.log(`  Session ${sessionId} deleted.`);
}

export default function registerSessionsCommand(program: Command): void {
  const sessions = program
    .command("sessions")
    .description("Manage hibernated team mode sessions");

  sessions
    .command("list")
    .description("List all hibernated sessions")
    .action(sessionsListAction);

  sessions
    .command("delete <sessionId>")
    .description("Delete a hibernated session by ID")
    .action(sessionsDeleteAction);
}
