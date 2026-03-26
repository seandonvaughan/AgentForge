#!/usr/bin/env node

import { Command } from "commander";
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

const program = new Command();

program
  .name("agentforge")
  .version("0.1.0")
  .description("Adaptive Agent Team Builder for Claude Code");

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
