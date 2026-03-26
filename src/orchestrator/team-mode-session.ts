import { randomUUID } from "node:crypto";
import { AgentAddressRegistry } from "./agent-address-registry.js";
import { SessionLifecycle } from "./session-lifecycle.js";
import { TeamModeBus } from "./team-mode-bus.js";
import { FeedRenderer } from "./feed-renderer.js";
import { AgentForgeSession } from "./session.js";
import type {
  TeamModeConfig,
  TeamSessionConfig,
  TeamModeState,
  TeamModeMessage,
  FeedEntry,
  AutonomyLevel,
} from "../types/team-mode.js";

export class TeamModeSession {
  private config: TeamModeConfig;
  private lifecycle: SessionLifecycle;
  private registry: AgentAddressRegistry | null = null;
  private bus: TeamModeBus | null = null;
  private feed: FeedRenderer;
  private innerSession: AgentForgeSession | null = null;
  private sessionId: string;
  private autonomyLevel: AutonomyLevel = "guided";
  private activatedAt: string | null = null;

  constructor(config: TeamModeConfig) {
    this.config = config;
    this.lifecycle = new SessionLifecycle();
    this.feed = new FeedRenderer();
    this.sessionId = randomUUID();
  }

  async activate(overrideAutonomy?: AutonomyLevel): Promise<void> {
    if (this.lifecycle.getState() !== "inactive" && this.lifecycle.getState() !== "hibernated") {
      throw new Error(`Cannot activate from state: ${this.lifecycle.getState()}`);
    }

    this.lifecycle.transition("activating");

    this.registry = new AgentAddressRegistry(this.config.teamManifest);
    this.bus = new TeamModeBus(this.registry);

    this.bus.onAnyMessage((msg) => {
      this.feed.addMessage(msg);
    });

    this.innerSession = await AgentForgeSession.create(this.config.sessionConfig);
    this.autonomyLevel = overrideAutonomy ?? this.detectAutonomy();
    this.activatedAt = new Date().toISOString();
    this.lifecycle.transition("active");
  }

  async deactivate(): Promise<void> {
    if (!this.lifecycle.isActive()) {
      throw new Error(`Cannot deactivate from state: ${this.lifecycle.getState()}`);
    }

    this.lifecycle.transition("deactivating");

    if (this.innerSession) {
      await this.innerSession.end();
      this.innerSession = null;
    }

    this.lifecycle.transition("inactive");
  }

  submitTask(taskContent: string): TeamModeMessage {
    if (!this.lifecycle.canAcceptTasks()) {
      throw new Error("Session not active — cannot accept tasks");
    }

    return this.bus!.send({
      from: "conduit:user",
      to: "agent:cto",
      type: "task",
      content: taskContent,
      priority: "normal",
    });
  }

  sendDirect(agentName: string, content: string): TeamModeMessage {
    if (!this.lifecycle.canAcceptTasks()) {
      throw new Error("Session not active — cannot send messages");
    }

    const address = this.registry!.resolve(agentName);
    if (!address) {
      throw new Error(`Unknown agent: ${agentName}`);
    }

    return this.bus!.send({
      from: "conduit:user",
      to: address,
      type: "direct",
      content,
      priority: "normal",
    });
  }

  getState(): TeamModeState {
    return this.lifecycle.getState();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getAutonomyLevel(): AutonomyLevel {
    return this.autonomyLevel;
  }

  getFeedEntries(): FeedEntry[] {
    return this.feed.getEntries();
  }

  getRecentFeed(count: number): FeedEntry[] {
    return this.feed.getRecentEntries(count);
  }

  formatFeedEntry(message: TeamModeMessage): string {
    return this.feed.formatMessage(message);
  }

  getAgentNames(): string[] {
    return this.registry?.getAgentNames() ?? [];
  }

  getBus(): TeamModeBus | null {
    return this.bus;
  }

  getRegistry(): AgentAddressRegistry | null {
    return this.registry;
  }

  getInnerSession(): AgentForgeSession | null {
    return this.innerSession;
  }

  getActivatedAt(): string | null {
    return this.activatedAt;
  }

  private detectAutonomy(): AutonomyLevel {
    if (!this.registry) return "guided";
    if (this.registry.getOpusAgents().length > 0) return "full";
    if (this.registry.getSonnetAgents().length > 0) return "supervised";
    return "guided";
  }
}
