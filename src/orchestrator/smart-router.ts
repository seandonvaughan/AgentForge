import type { TeamManifest } from "../types/team.js";

export interface DirectMessage {
  agentName: string;
  content: string;
}

const OPUS_KEYWORDS = ["architect", "architecture", "strateg", "design", "plan", "vision", "roadmap"];
const SONNET_KEYWORDS = ["implement", "build", "code", "develop", "create", "write", "add", "fix", "refactor"];

export class SmartRouter {
  private manifest: TeamManifest;
  private taskCount = 0;
  private knownAgents: Set<string>;

  constructor(manifest: TeamManifest) {
    this.manifest = manifest;
    this.knownAgents = new Set([
      ...manifest.model_routing.opus,
      ...manifest.model_routing.sonnet,
      ...manifest.model_routing.haiku,
    ]);
  }

  parseDirectMessage(input: string): DirectMessage | null {
    const match = input.match(/^@([\w-]+)\s*(.*)/s);
    if (!match) return null;
    const agentName = match[1];
    if (!this.knownAgents.has(agentName)) return null;
    this.taskCount++;
    return { agentName, content: match[2].trim() };
  }

  routeTask(task: string): string | null {
    this.taskCount++;
    const lower = task.toLowerCase();
    const opusAgents = this.manifest.model_routing.opus;
    const sonnetAgents = this.manifest.model_routing.sonnet;

    if (opusAgents.length > 0 && OPUS_KEYWORDS.some((kw) => lower.includes(kw))) {
      return opusAgents[0];
    }
    if (sonnetAgents.length > 0 && SONNET_KEYWORDS.some((kw) => lower.includes(kw))) {
      return sonnetAgents[0];
    }
    if (opusAgents.length > 0) return opusAgents[0];
    if (sonnetAgents.length > 0) return sonnetAgents[0];
    return null;
  }

  isFirstTask(): boolean {
    return this.taskCount === 0;
  }
}
