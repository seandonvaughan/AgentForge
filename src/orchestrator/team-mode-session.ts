import { randomUUID } from "node:crypto";
import { AgentAddressRegistry } from "./agent-address-registry.js";
import { SessionLifecycle } from "./session-lifecycle.js";
import { TeamModeBus } from "./team-mode-bus.js";
import { FeedRenderer } from "./feed-renderer.js";
import { SmartRouter } from "./smart-router.js";
import { CtoFramer } from "./cto-framer.js";
import { detectAutonomy } from "./autonomy-detector.js";
import { SessionSerializer } from "./session-serializer.js";
import { StalenessDetector } from "./staleness-detector.js";
import { AgentForgeSession } from "./session.js";
import type {
  TeamModeConfig,
  TeamSessionConfig,
  TeamModeState,
  TeamModeMessage,
  FeedEntry,
  AutonomyLevel,
  HibernatedSession,
} from "../types/team-mode.js";

export interface UserInputResult {
  message: TeamModeMessage;
  displayTier: string;
  formatted: string | null;
  isDirect: boolean;
  targetAgent: string;
}

export class TeamModeSession {
  private config: TeamModeConfig;
  private lifecycle: SessionLifecycle;
  private registry: AgentAddressRegistry | null = null;
  private bus: TeamModeBus | null = null;
  private feed: FeedRenderer;
  private router: SmartRouter | null = null;
  private framer: CtoFramer | null = null;
  private innerSession: AgentForgeSession | null = null;
  private sessionId: string;
  private autonomyLevel: AutonomyLevel = "guided";
  private activatedAt: string | null = null;
  private spentUsd = 0;

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
    this.router = new SmartRouter(this.config.teamManifest);
    this.framer = new CtoFramer(this.registry);

    this.bus.onAnyMessage((msg) => {
      this.feed.addMessage(msg);
    });

    this.innerSession = await AgentForgeSession.create(this.config.sessionConfig);
    this.autonomyLevel = overrideAutonomy ?? detectAutonomy(this.config.teamManifest);
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

  submitUserInput(input: string): UserInputResult {
    if (!this.lifecycle.canAcceptTasks()) {
      throw new Error("Session not active — cannot accept input");
    }

    const direct = this.router!.parseDirectMessage(input);

    let message: TeamModeMessage;
    let isDirect = false;
    let targetAgent: string;

    if (direct) {
      isDirect = true;
      targetAgent = direct.agentName;
      message = this.bus!.send({
        from: "conduit:user",
        to: `agent:${direct.agentName}`,
        type: "direct",
        content: direct.content,
        priority: "normal",
      });
    } else {
      const routed = this.router!.routeTask(input);
      targetAgent = routed ?? (this.registry!.getAgentNames()[0] ?? "cto");
      message = this.bus!.send({
        from: "conduit:user",
        to: `agent:${targetAgent}`,
        type: "task",
        content: input,
        priority: "normal",
      });
    }

    const displayTier = this.feed.getDisplayTier(message);
    const formatted = this.feed.formatByTier(message);

    return { message, displayTier, formatted, isDirect, targetAgent };
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

  getRouter(): SmartRouter | null {
    return this.router;
  }

  getFramer(): CtoFramer | null {
    return this.framer;
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

  getSpentUsd(): number {
    return this.spentUsd;
  }

  addSpend(usd: number): void {
    this.spentUsd += usd;
  }

  async hibernate(): Promise<HibernatedSession> {
    if (!this.lifecycle.isActive()) {
      throw new Error(`Cannot hibernate from state: ${this.lifecycle.getState()}`);
    }

    this.lifecycle.transition("hibernating");

    const detector = new StalenessDetector(this.config.sessionConfig.projectRoot);
    const gitCommit = await detector.getCurrentCommit();

    const snapshot: HibernatedSession = {
      sessionId: this.sessionId,
      autonomyLevel: this.autonomyLevel,
      hibernatedAt: new Date().toISOString(),
      projectRoot: this.config.sessionConfig.projectRoot,
      teamManifest: this.config.teamManifest,
      feedEntries: this.feed.getEntries(),
      gitCommitAtHibernation: gitCommit,
      sessionBudgetUsd: this.config.sessionConfig.sessionBudgetUsd,
      spentUsd: this.spentUsd,
    };

    const serializer = new SessionSerializer(this.config.sessionConfig.projectRoot);
    await serializer.save(snapshot);

    if (this.innerSession) {
      await this.innerSession.end();
      this.innerSession = null;
    }

    this.lifecycle.transition("hibernated");
    return snapshot;
  }
}
