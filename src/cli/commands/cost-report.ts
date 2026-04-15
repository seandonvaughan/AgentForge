import type { Command } from "commander";
import { costReportCompatibility } from "../compat/package-run-services.js";

async function costReportAction(options: {
  projectRoot?: string;
}): Promise<void> {
  console.warn("[compat] `cost-report` is a root compatibility wrapper. Prefer `agentforge costs report` from the package CLI.");
  await costReportCompatibility(options);
}

export default function registerCostReportCommand(program: Command): void {
  program
    .command("cost-report")
    .description("Compatibility wrapper for package-canonical `costs report`")
    .option("--project-root <path>", "Project root", process.cwd())
    .action(costReportAction);
}
