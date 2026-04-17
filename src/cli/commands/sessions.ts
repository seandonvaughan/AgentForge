import type { Command } from "commander";
import { listTeamSessions, deleteTeamSession } from "@agentforge/core";
import { warnDeprecation } from "../utils/run-helpers.js";

const SESSIONS_DEPRECATION =
  "[compat] `sessions` is a root compatibility wrapper. Prefer `agentforge team-sessions` from the package CLI.";

async function runSessionAction(action: () => Promise<number>): Promise<void> {
  try {
    const exitCode = await action();
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function sessionsListAction(): Promise<void> {
  warnDeprecation(SESSIONS_DEPRECATION);
  await runSessionAction(() => listTeamSessions(process.cwd()));
}

async function sessionsDeleteAction(sessionId: string): Promise<void> {
  warnDeprecation(SESSIONS_DEPRECATION);
  await runSessionAction(() => deleteTeamSession(process.cwd(), sessionId));
}

export default function registerSessionsCommand(program: Command): void {
  const sessions = program
    .command("sessions")
    .description("Compatibility wrapper for package-canonical `team-sessions`");

  sessions
    .command("list")
    .description("List all hibernated sessions")
    .action(sessionsListAction);

  sessions
    .command("delete <sessionId>")
    .description("Delete a hibernated session by ID")
    .action(sessionsDeleteAction);
}
