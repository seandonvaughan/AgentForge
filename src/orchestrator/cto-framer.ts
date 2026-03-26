import type { AgentAddressRegistry } from "./agent-address-registry.js";

export class CtoFramer {
  private registry: AgentAddressRegistry;

  constructor(registry: AgentAddressRegistry) {
    this.registry = registry;
  }

  getCtoAgent(): string | null {
    return this.registry.getOpusAgents()[0] ?? null;
  }

  buildFramingPrompt(task: string): string {
    const agents = this.registry.getAgentNames();
    const agentList = agents.join(", ");
    return [
      `You are the CTO of this engineering team. A new task has been submitted:`,
      ``,
      `TASK: ${task}`,
      ``,
      `Available agents: ${agentList}`,
      ``,
      `Decompose this task into workstreams. For each workstream, specify:`,
      `1. The workstream goal`,
      `2. Which agent should lead it (delegate to the most appropriate agent)`,
      `3. Any dependencies between workstreams`,
      ``,
      `Respond with a clear workstream breakdown that can be actioned immediately.`,
    ].join("\n");
  }
}
