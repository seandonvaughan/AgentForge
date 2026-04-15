import type { Command } from "commander";
import {
  deleteTeamSessionCompatibility,
  listTeamSessionsCompatibility,
} from "../compat/package-team-services.js";

async function sessionsListAction(): Promise<void> {
  console.warn("[compat] `sessions` is a root compatibility wrapper. Prefer `agentforge team-sessions` from the package CLI.");
  await listTeamSessionsCompatibility();
}

async function sessionsDeleteAction(sessionId: string): Promise<void> {
  console.warn("[compat] `sessions` is a root compatibility wrapper. Prefer `agentforge team-sessions` from the package CLI.");
  await deleteTeamSessionCompatibility(sessionId);
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
