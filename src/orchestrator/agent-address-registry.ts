import type { TeamManifest, DelegationGraph, ModelRouting } from "../types/team.js";
import type { ModelTier } from "../types/agent.js";

export class AgentAddressRegistry {
  private agents: Set<string>;
  private delegationGraph: DelegationGraph;
  private modelRouting: ModelRouting;
  private peerGroups: Map<string, Set<string>>;

  constructor(manifest: TeamManifest) {
    this.agents = new Set<string>();
    this.delegationGraph = manifest.delegation_graph;
    this.modelRouting = manifest.model_routing;
    this.peerGroups = new Map();

    for (const agents of Object.values(manifest.agents)) {
      for (const agent of agents) {
        this.agents.add(agent);
      }
    }

    for (const [, children] of Object.entries(this.delegationGraph)) {
      const group = new Set(children);
      for (const child of children) {
        const existing = this.peerGroups.get(child) ?? new Set();
        for (const peer of group) {
          if (peer !== child) existing.add(peer);
        }
        this.peerGroups.set(child, existing);
      }
    }
  }

  hasAgent(name: string): boolean {
    return this.agents.has(name);
  }

  hasAddress(address: string): boolean {
    if (address === "conduit:user") return true;
    const parts = address.split(":");
    if (parts.length !== 2 || parts[0] !== "agent") return false;
    return this.agents.has(parts[1]!);
  }

  resolve(agentName: string): string | null {
    if (!this.agents.has(agentName)) return null;
    return `agent:${agentName}`;
  }

  getAgentNames(): string[] {
    return Array.from(this.agents);
  }

  canRoute(fromAgent: string, toAgent: string): boolean {
    const delegates = this.delegationGraph[fromAgent];
    if (delegates?.includes(toAgent)) return true;

    const parentDelegates = this.delegationGraph[toAgent];
    if (parentDelegates?.includes(fromAgent)) return true;

    const peers = this.peerGroups.get(fromAgent);
    if (peers?.has(toAgent)) return true;

    return false;
  }

  canRouteFromUser(toAgent: string): boolean {
    return this.agents.has(toAgent);
  }

  canRouteToUser(fromAgent: string): boolean {
    return this.agents.has(fromAgent);
  }

  getModelTier(agentName: string): ModelTier | null {
    if (this.modelRouting.opus.includes(agentName)) return "opus";
    if (this.modelRouting.sonnet.includes(agentName)) return "sonnet";
    if (this.modelRouting.haiku.includes(agentName)) return "haiku";
    return null;
  }

  getOpusAgents(): string[] {
    return this.modelRouting.opus.filter((a) => this.agents.has(a));
  }

  getSonnetAgents(): string[] {
    return this.modelRouting.sonnet.filter((a) => this.agents.has(a));
  }

  getHaikuAgents(): string[] {
    return this.modelRouting.haiku.filter((a) => this.agents.has(a));
  }
}