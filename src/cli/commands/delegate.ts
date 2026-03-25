import type { Command } from "commander";

async function delegateAction(taskParts: string[]): Promise<void> {
  const task = taskParts.join(" ");
  console.log(`Delegating task: ${task}`);

  // TODO: analyze task and route to the best-matching agent
  console.log("No agents available to handle this task. Run `agentforge forge` first.");
}

export default function registerDelegateCommand(program: Command): void {
  program
    .command("delegate")
    .description("Route a task to the best agent automatically")
    .argument("<task...>", "Task description")
    .action(delegateAction);
}
