import { describe, it, expect, beforeEach } from "vitest";
import { Orchestrator } from "../../src/orchestrator/index.js";
import type { AgentTemplate } from "../../src/types/agent.js";
import type { TeamManifest } from "../../src/types/team.js";
import type { CollaborationTemplate } from "../../src/types/collaboration.js";
import type { TeamEvent } from "../../src/types/orchestration.js";

/* ------------------------------------------------------------------ */
/*  Shared fixtures                                                    */
/* ------------------------------------------------------------------ */

function makeAgent(overrides: Partial<AgentTemplate> = {}): AgentTemplate {
  return {
    name: "coder",
    model: "sonnet",
    version: "1.0",
    description: "Writes code",
    system_prompt: "You write code.",
    skills: ["code_write"],
    triggers: { file_patterns: ["*.ts"], keywords: ["implement"] },
    collaboration: {
      reports_to: "architect",
      reviews_from: ["reviewer"],
      can_delegate_to: ["test-engineer"],
      parallel: false,
    },
    context: {
      max_files: 10,
      auto_include: [],
      project_specific: [],
    },
    subscriptions: ["security_alert"],
    ...overrides,
  };
}

const manifest: TeamManifest = {
  name: "Test Team",
  forged_at: "2025-01-01T00:00:00Z",
  forged_by: "test",
  project_hash: "abc123",
  agents: {
    strategic: ["architect"],
    implementation: ["coder"],
    quality: ["reviewer"],
    utility: [],
  },
  model_routing: {
    opus: ["architect"],
    sonnet: ["coder", "reviewer"],
    haiku: [],
  },
  delegation_graph: {
    architect: ["coder"],
    coder: ["reviewer"],
    reviewer: [],
  },
};

const template: CollaborationTemplate = {
  name: "test-template",
  type: "hierarchy",
  description: "Test collaboration template",
  topology: { root: "architect", levels: [{ agents: ["architect"], role: "lead" }] },
  delegation_rules: {
    direction: "top-down",
    cross_level: false,
    peer_collaboration: false,
    review_flow: "bottom-up",
  },
  communication: { patterns: ["request-response"], gates: [] },
  escalation: { max_retries: 3, escalate_to: "architect", human_escalation: false },
  loop_limits: {
    review_cycle: 2,
    delegation_depth: 3,
    retry_same_agent: 1,
    total_actions: 10,
  },
};

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("Orchestrator v2 runtime", () => {
  let agents: Map<string, AgentTemplate>;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    agents = new Map<string, AgentTemplate>();
    agents.set("coder", makeAgent({ name: "coder", subscriptions: ["security_alert"] }));
    agents.set(
      "architect",
      makeAgent({
        name: "architect",
        model: "opus",
        subscriptions: ["architecture_decision"],
      }),
    );
    agents.set(
      "reviewer",
      makeAgent({
        name: "reviewer",
        model: "sonnet",
        subscriptions: ["security_alert", "architecture_decision"],
      }),
    );
    orchestrator = new Orchestrator(manifest, agents, template);
  });

  /* ---------------------------------------------------------------- */
  /*  startTask                                                        */
  /* ---------------------------------------------------------------- */
  it("startTask creates progress ledger and initializes loop guard", () => {
    const taskId = orchestrator.startTask("coder", "implement login");

    expect(typeof taskId).toBe("string");
    expect(taskId.length).toBeGreaterThan(0);

    // Health check should return healthy defaults
    const health = orchestrator.checkHealth(taskId);
    expect(health).toBeDefined();
    expect(health.is_in_loop).toBe(false);
    expect(health.is_progress_being_made).toBe(true);
  });

  /* ---------------------------------------------------------------- */
  /*  recordProgress                                                   */
  /* ---------------------------------------------------------------- */
  it("recordProgress updates ledger and checks health", () => {
    const taskId = orchestrator.startTask("coder", "implement login");

    const result = orchestrator.recordProgress(taskId, "Created login component");

    expect(result.is_in_loop).toBe(false);
    expect(result.is_progress_being_made).toBe(true);
  });

  it("recordProgress escalates when loop detected", () => {
    const taskId = orchestrator.startTask("coder", "implement login");

    // Record the same step 3 times to trigger loop detection
    orchestrator.recordProgress(taskId, "retry connection");
    orchestrator.recordProgress(taskId, "retry connection");
    const result = orchestrator.recordProgress(taskId, "retry connection");

    expect(result.is_in_loop).toBe(true);
  });

  it("recordProgress checks loop guard total_actions limit", () => {
    // Create orchestrator with very low total_actions limit
    const tightTemplate: CollaborationTemplate = {
      ...template,
      loop_limits: {
        review_cycle: 2,
        delegation_depth: 3,
        retry_same_agent: 1,
        total_actions: 3,
      },
    };
    const tightOrchestrator = new Orchestrator(manifest, agents, tightTemplate);
    const taskId = tightOrchestrator.startTask("coder", "task");

    tightOrchestrator.recordProgress(taskId, "step 1");
    tightOrchestrator.recordProgress(taskId, "step 2");
    tightOrchestrator.recordProgress(taskId, "step 3");

    // Fourth step exceeds total_actions limit of 3
    const result = tightOrchestrator.recordProgress(taskId, "step 4");
    expect(result.limitExceeded).toBe(true);
    expect(result.reason).toContain("total_actions");
  });

  /* ---------------------------------------------------------------- */
  /*  broadcast                                                        */
  /* ---------------------------------------------------------------- */
  it("broadcast delivers events to subscribed agents", () => {
    const event: TeamEvent = {
      type: "security_alert",
      source: "architect",
      payload: { severity: "high" },
      notify: ["*"],
    };

    const notified = orchestrator.broadcast(event);

    // coder and reviewer subscribe to security_alert
    expect(notified).toContain("coder");
    expect(notified).toContain("reviewer");
    // architect does not subscribe to security_alert
    expect(notified).not.toContain("architect");
  });

  it("broadcast returns empty array when no subscribers match", () => {
    const event: TeamEvent = {
      type: "unknown_event",
      source: "coder",
      payload: {},
      notify: ["*"],
    };

    const notified = orchestrator.broadcast(event);
    expect(notified).toEqual([]);
  });

  /* ---------------------------------------------------------------- */
  /*  handoff                                                          */
  /* ---------------------------------------------------------------- */
  it("handoff creates structured handoff with artifact metadata", () => {
    const handoff = orchestrator.handoff("coder", "reviewer", {
      type: "code",
      summary: "Login component implementation",
      location: "src/components/login.tsx",
      confidence: 0.9,
    });

    expect(handoff.from).toBe("coder");
    expect(handoff.to).toBe("reviewer");
    expect(handoff.artifact.type).toBe("code");
    expect(handoff.artifact.summary).toBe("Login component implementation");
    expect(handoff.artifact.location).toBe("src/components/login.tsx");
    expect(handoff.artifact.confidence).toBe(0.9);
    expect(handoff.open_questions).toEqual([]);
    expect(handoff.constraints).toEqual([]);
    expect(handoff.status).toBe("needs_review");
  });

  it("handoff accepts optional open questions and constraints", () => {
    const handoff = orchestrator.handoff(
      "coder",
      "reviewer",
      {
        type: "code",
        summary: "Login form",
        location: "src/login.ts",
        confidence: 0.8,
      },
      {
        openQuestions: ["Should we support SSO?"],
        constraints: ["Must use OAuth 2.0"],
        status: "partial",
      },
    );

    expect(handoff.open_questions).toEqual(["Should we support SSO?"]);
    expect(handoff.constraints).toEqual(["Must use OAuth 2.0"]);
    expect(handoff.status).toBe("partial");
  });

  /* ---------------------------------------------------------------- */
  /*  checkHealth                                                      */
  /* ---------------------------------------------------------------- */
  it("checkHealth returns combined ledger and loop guard status", () => {
    const taskId = orchestrator.startTask("coder", "implement login");

    orchestrator.recordProgress(taskId, "step 1");
    orchestrator.recordProgress(taskId, "step 2");

    const health = orchestrator.checkHealth(taskId);

    expect(health.is_in_loop).toBe(false);
    expect(health.is_progress_being_made).toBe(true);
    expect(health.loopGuardCounters).toBeDefined();
    expect(typeof health.loopGuardCounters.total_actions).toBe("number");
  });

  it("checkHealth throws for unknown task id", () => {
    expect(() => orchestrator.checkHealth("nonexistent")).toThrow();
  });

  /* ---------------------------------------------------------------- */
  /*  assembleContext                                                   */
  /* ---------------------------------------------------------------- */
  it("assembleContext uses context manager for agent invocation", () => {
    const context = orchestrator.assembleContext("coder", "implement login");

    // Should contain the task description
    expect(context).toContain("implement login");
    // Should contain a Task section header
    expect(context).toContain("## Task");
  });

  it("assembleContext includes decisions recorded via context manager", () => {
    orchestrator.contextManager.saveDecision(
      "architect",
      "Use React for frontend",
      "Team familiarity with React",
    );

    const context = orchestrator.assembleContext("coder", "implement login");

    expect(context).toContain("Use React for frontend");
    expect(context).toContain("Team Decisions");
  });

  it("assembleContext throws for unknown agent", () => {
    expect(() => orchestrator.assembleContext("ghost", "do stuff")).toThrow();
  });

  /* ---------------------------------------------------------------- */
  /*  Constructor                                                      */
  /* ---------------------------------------------------------------- */
  it("constructor works without collaboration template (uses defaults)", () => {
    const orch = new Orchestrator(manifest, agents);

    // Should still be able to use all runtime methods
    const taskId = orch.startTask("coder", "a task");
    expect(typeof taskId).toBe("string");

    const health = orch.checkHealth(taskId);
    expect(health.is_in_loop).toBe(false);
  });

  it("constructor sets up event subscriptions from agent templates", () => {
    // Verify agents' subscriptions were registered on the event bus
    const event: TeamEvent = {
      type: "architecture_decision",
      source: "coder",
      payload: { decision: "use microservices" },
      notify: ["*"],
    };

    const notified = orchestrator.broadcast(event);

    // architect and reviewer subscribe to architecture_decision
    expect(notified).toContain("architect");
    expect(notified).toContain("reviewer");
    expect(notified).not.toContain("coder");
  });
});
