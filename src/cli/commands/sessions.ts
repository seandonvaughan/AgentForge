import type { Command } from "commander";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function sessionsListAction(): void {
  console.warn("[compat] `sessions` is a root compatibility wrapper. Prefer `agentforge team-sessions` from the package CLI.");
  forwardToPackageCli("team-sessions list", ["team-sessions", "list"]);
}

function sessionsDeleteAction(sessionId: string): void {
  console.warn("[compat] `sessions` is a root compatibility wrapper. Prefer `agentforge team-sessions` from the package CLI.");
  forwardToPackageCli("team-sessions delete", ["team-sessions", "delete", sessionId]);
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

function forwardToPackageCli(preferredCommand: string, args: string[]): void {
  const packageCliPath = fileURLToPath(new URL("../../../packages/cli/dist/bin.js", import.meta.url));
  if (!existsSync(packageCliPath)) {
    console.error(`Package CLI build not found at ${packageCliPath}. Build packages/cli first, then run \`${preferredCommand}\`.`);
    process.exitCode = 1;
    return;
  }

  const result = spawnSync(process.execPath, [packageCliPath, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      AGENTFORGE_ROOT_COMPAT: "1",
    },
  });

  if (typeof result.status === "number") {
    process.exitCode = result.status;
    return;
  }

  const message = result.error instanceof Error ? result.error.message : `Failed to run ${preferredCommand}`;
  console.error(message);
  process.exitCode = 1;
}
