import type { AgentIdentity, ExecutiveTool, ExecutiveToolPermission, SeniorityLevel } from "../../types/lifecycle.js";

const SENIORITY_ORDER: SeniorityLevel[] = ["junior", "mid", "senior", "lead", "principal"];

export class ExecutiveToolError extends Error {
  constructor(
    public readonly tool: string,
    public readonly agentId: string,
    public readonly reason: string,
  ) {
    super(`Tool "${tool}" denied for agent "${agentId}": ${reason}`);
    this.name = "ExecutiveToolError";
  }
}

export function checkAuthorization(agent: AgentIdentity, permission: ExecutiveToolPermission): void {
  if (permission.requiredAgentId && agent.id !== permission.requiredAgentId) {
    throw new ExecutiveToolError("", agent.id, `requires agent "${permission.requiredAgentId}"`);
  }
  if (agent.role !== permission.requiredRole && permission.requiredRole !== "specialist") {
    throw new ExecutiveToolError("", agent.id, `requires role "${permission.requiredRole}", has "${agent.role}"`);
  }
  const agentSeniorityIdx = SENIORITY_ORDER.indexOf(agent.seniority);
  const requiredSeniorityIdx = SENIORITY_ORDER.indexOf(permission.minSeniority);
  if (agentSeniorityIdx < requiredSeniorityIdx) {
    throw new ExecutiveToolError("", agent.id, `requires seniority "${permission.minSeniority}", has "${agent.seniority}"`);
  }
}

export abstract class BaseToolSuite {
  abstract readonly role: string;
  abstract getTools(): ExecutiveTool[];

  checkAccess(agent: AgentIdentity, toolName: string): void {
    const tool = this.getTools().find(t => t.name === toolName);
    if (!tool) throw new ExecutiveToolError(toolName, agent.id, "tool not found");
    checkAuthorization(agent, tool.permission);
  }
}
