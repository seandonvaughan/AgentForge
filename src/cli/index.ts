#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLI_VERSION = readPackageVersion();
const program = new Command();

program
  .name("agentforge")
  .version(CLI_VERSION)
  .description("Adaptive Agent Team Builder for Claude Code (root compatibility CLI — deprecated; use packages/cli instead)");

emitCompatibilityNotice();

// All commands have been consolidated into packages/cli. Root CLI is now a
// deprecation stub that points users to the canonical package CLI.
// Previously supported commands (forge, genesis, rebuild, reforge, team, status,
// sessions, invoke, delegate, cost-report, activate, deactivate) now route
// through: `packages/cli/src/bin.ts`

program.parse();

function readPackageVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
    return packageJson.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function emitCompatibilityNotice(): void {
  if (
    process.env.AGENTFORGE_BRIDGED === "1" ||
    process.env.AGENTFORGE_SUPPRESS_DEPRECATION === "1"
  ) {
    return;
  }
  console.warn(
    "[compat] Root CLI is deprecated and has no commands.\n" +
    "[compat] All AgentForge commands now live in the package CLI.\n" +
    "[compat] Usage: npm exec agentforge -- <command> (or use packages/cli directly)\n" +
    "[compat] To suppress: set AGENTFORGE_SUPPRESS_DEPRECATION=1"
  );
}
