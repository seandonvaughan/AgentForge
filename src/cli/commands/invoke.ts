import type { Command } from "commander";

async function invokeAction(
  agentName: string,
  taskParts: string[],
): Promise<void> {
  const task = taskParts.join(" ");
  console.log(`Invoking agent "${agentName}" with task: ${task}`);

  // TODO: resolve agent by name and dispatch task
  console.log(`Agent "${agentName}" is not yet implemented.`);
}

export default function registerInvokeCommand(program: Command): void {
  program
    .command("invoke")
    .description("Invoke a specific agent")
    .argument("<agent>", "Name of the agent to invoke")
    .argument("<task...>", "Task description")
    .action(invokeAction);
}
