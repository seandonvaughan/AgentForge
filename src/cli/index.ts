#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import registerForgeCommand from "./commands/forge.js";
import registerGenesisCommand from "./commands/genesis.js";
import registerRebuildCommand from "./commands/rebuild.js";
import registerReforgeCommand from "./commands/reforge.js";
import registerTeamCommand from "./commands/team.js";
import registerStatusCommand from "./commands/status.js";
import registerInvokeCommand from "./commands/invoke.js";
import registerDelegateCommand from "./commands/delegate.js";
import registerCostReportCommand from "./commands/cost-report.js";
import registerActivateCommand from "./commands/activate.js";
import registerDeactivateCommand from "./commands/deactivate.js";
import registerSessionsCommand from "./commands/sessions.js";

const CLI_VERSION = readPackageVersion();
const program = new Command();

program
  .name("agentforge")
  .version(CLI_VERSION)
  .description("Adaptive Agent Team Builder for Claude Code (root compatibility CLI; package CLI is canonical)");

emitCompatibilityNotice();

registerForgeCommand(program);
registerGenesisCommand(program);
registerRebuildCommand(program);
registerReforgeCommand(program);
registerTeamCommand(program);
registerStatusCommand(program);
registerInvokeCommand(program);
registerDelegateCommand(program);
registerCostReportCommand(program);
registerActivateCommand(program);
registerDeactivateCommand(program);
registerSessionsCommand(program);

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
  if (process.env.AGENTFORGE_BRIDGED === "1") {
    return;
  }
  console.warn("[compat] Root CLI surface is compatibility mode. Canonical commands now route through package-core/package-server services; deprecated commands remain as shims only.");
}
