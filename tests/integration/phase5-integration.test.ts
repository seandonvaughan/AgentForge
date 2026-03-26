/**
 * Phase 5 Integration Tests — Sprint 5.3
 *
 * Gate criteria:
 *  - Meta-learning generates ≥2 actionable insights in simulated sprints
 *  - Graduated autonomy: at least 1 agent promoted during simulation
 *  - Capability inheritance: ≥1 skill successfully propagated to a peer
 *  - Velocity ratio >1.05 across simulated sprints
 *  - Flywheel health monitor confirms all 4 components active
 */

import { describe, it, expect } from "vitest";
import { MetaLearningEngine } from "../../src/flywheel/meta-learning-engine.js";
import { CapabilityInheritance } from "../../src/flywheel/capability-inheritance.js";
import { AutonomyGovernor } from "../../src/flywheel/autonomy-governor.js";
import { FlywheelMonitor } from "../../src/flywheel/flywheel-monitor.js";

/**
 * Simulate 3 sprints of agent work to demonstrate flywheel compounding.
 */
function simulateSprints() {
  const metalearning = new MetaLearningEngine();
  const inheritance = new CapabilityInheritance();
  const autonomy = new AutonomyGovernor();
  const monitor = new FlywheelMonitor();

  // Register agents
  const agents = ["cto", "architect", "bus-agent", "review-router-agent", "org-graph-agent"];
  for (const a of agents) autonomy.register(a, 1);

  // Register initial skills
  inheritance.registerSkill("cto", { skillId: "system-design", proficiency: 0.95, exerciseCount: 20 });
  inheritance.registerSkill("cto", { skillId: "code-review", proficiency: 0.85, exerciseCount: 15 });
  inheritance.registerSkill("architect", { skillId: "typescript", proficiency: 0.9, exerciseCount: 18 });

  // ── Sprint 1 ──────────────────────────────────────────────────
  for (let i = 0; i < 8; i++) {
    metalearning.recordOutcome({
      taskId: `s1-t${i}`, agentId: agents[i % agents.length],
      description: `Sprint 1 task ${i}`, success: i < 7,
      durationMs: 5000 + i * 1000,
      patternsUsed: i % 2 === 0 ? ["tdd", "pair-review"] : ["solo-impl"],
      lessonsLearned: ["TDD reduces rework"],
      sprintId: "sprint-1",
    });
    autonomy.recordSuccess(agents[i % agents.length]);
  }
  // Add clearly-failing pattern for insight contrast
  for (let i = 0; i < 5; i++) {
    metalearning.recordOutcome({
      taskId: `s1-fail${i}`, agentId: agents[i % agents.length],
      description: `Sprint 1 rush task ${i}`, success: i < 1, // 20% success
      durationMs: 2000,
      patternsUsed: ["yolo-deploy"],
      lessonsLearned: ["Skipping validation causes failures"],
      sprintId: "sprint-1",
    });
  }
  monitor.recordSprintVelocity({
    sprintId: "sprint-1", tasksCompleted: 7, tasksPlanned: 8, durationMs: 604800000,
  });

  // ── Sprint 2 (improved from Sprint 1 learnings) ──────────────
  // Propagate skills
  inheritance.optIn("architect", "system-design");
  inheritance.propagate("cto", "architect", "system-design");
  monitor.recordInheritanceEvent("cto", "architect", "system-design");

  for (let i = 0; i < 10; i++) {
    metalearning.recordOutcome({
      taskId: `s2-t${i}`, agentId: agents[i % agents.length],
      description: `Sprint 2 task ${i}`, success: i < 9,
      durationMs: 4000 + i * 500,
      patternsUsed: ["tdd", "pair-review"], // learned from sprint 1
      lessonsLearned: ["Pair review catches more bugs"],
      sprintId: "sprint-2",
    });
    autonomy.recordSuccess(agents[i % agents.length]);
  }
  monitor.recordSprintVelocity({
    sprintId: "sprint-2", tasksCompleted: 9, tasksPlanned: 10, durationMs: 604800000,
  });

  // ── Sprint 3 (compounding) ────────────────────────────────────
  // More skill propagation
  inheritance.optIn("bus-agent", "code-review");
  inheritance.propagate("cto", "bus-agent", "code-review");
  monitor.recordInheritanceEvent("cto", "bus-agent", "code-review");

  for (let i = 0; i < 12; i++) {
    metalearning.recordOutcome({
      taskId: `s3-t${i}`, agentId: agents[i % agents.length],
      description: `Sprint 3 task ${i}`, success: true,
      durationMs: 3000 + i * 300,
      patternsUsed: ["tdd", "pair-review", "automated-checks"],
      lessonsLearned: ["Automated checks reduce review time"],
      sprintId: "sprint-3",
    });
    autonomy.recordSuccess(agents[i % agents.length]);
  }
  monitor.recordSprintVelocity({
    sprintId: "sprint-3", tasksCompleted: 12, tasksPlanned: 12, durationMs: 604800000,
  });

  // Evaluate promotions for agents with enough successes
  const promotions = [];
  for (const a of agents) {
    const result = autonomy.evaluatePromotion(a);
    if (result.promoted) {
      promotions.push(result);
      monitor.recordPromotionEvent(a, result.previousTier, result.newTier);
    }
  }

  // Generate insights
  const insights = metalearning.generateInsights();
  for (const insight of insights) {
    if (insight.actionable) monitor.recordInsight(insight.recommendation);
  }

  return { metalearning, inheritance, autonomy, monitor, promotions, insights };
}

describe("Phase 5 gate — simulated 3-sprint flywheel", () => {
  it("meta-learning generates ≥2 actionable insights", () => {
    const { insights } = simulateSprints();
    const actionable = insights.filter((i) => i.actionable);
    expect(actionable.length).toBeGreaterThanOrEqual(2);
  });

  it("graduated autonomy: at least 1 agent promoted", () => {
    const { promotions } = simulateSprints();
    expect(promotions.length).toBeGreaterThanOrEqual(1);
  });

  it("capability inheritance: ≥1 skill propagated successfully", () => {
    const { inheritance } = simulateSprints();
    const history = inheritance.getPropagationHistory();
    const successes = history.filter((r) => r.success);
    expect(successes.length).toBeGreaterThanOrEqual(1);
  });

  it("velocity ratio >1.05 across sprints", () => {
    const { monitor } = simulateSprints();
    // Sprint 2→3: 12/9 = 1.33
    expect(monitor.getVelocityRatio()).toBeGreaterThan(1.05);
  });

  it("flywheel health: all 4 components active", () => {
    const { monitor } = simulateSprints();
    const health = monitor.getFlywheelHealth();
    expect(health.allActive).toBe(true);
    expect(health.components.every((c) => c.active)).toBe(true);
    expect(health.components.map((c) => c.name)).toEqual([
      "meta-learning",
      "graduated-autonomy",
      "capability-inheritance",
      "velocity-acceleration",
    ]);
  });

  it("meta-learning knowledge graph connects patterns", () => {
    const { metalearning } = simulateSprints();
    const graph = metalearning.getKnowledgeGraph();
    expect(graph.nodes.length).toBeGreaterThanOrEqual(3);
    expect(graph.edges.length).toBeGreaterThan(0);
    // tdd + pair-review should be strongly connected
    const tddPair = graph.edges.find(
      (e) => (e.from === "pair-review" && e.to === "tdd") ||
             (e.from === "tdd" && e.to === "pair-review")
    );
    expect(tddPair).toBeDefined();
    expect(tddPair!.cooccurrences).toBeGreaterThan(5);
  });

  it("sprint velocity shows acceleration trend", () => {
    const { monitor } = simulateSprints();
    const velocities = monitor.getVelocities();
    expect(velocities).toHaveLength(3);
    // Each sprint completed more tasks: 7 → 9 → 12
    expect(velocities[0].tasksCompleted).toBeLessThan(velocities[1].tasksCompleted);
    expect(velocities[1].tasksCompleted).toBeLessThan(velocities[2].tasksCompleted);
  });
});

describe("Phase 5 gate — component isolation", () => {
  it("autonomy governor handles demotion correctly in isolation", () => {
    const gov = new AutonomyGovernor();
    gov.register("risky-agent", 3);
    gov.recordFailure("risky-agent");
    gov.recordFailure("risky-agent");
    gov.recordFailure("risky-agent");
    const result = gov.evaluateDemotion("risky-agent");
    expect(result.demoted).toBe(true);
    expect(result.newTier).toBe(2);
  });

  it("capability inheritance respects opt-in", () => {
    const ci = new CapabilityInheritance();
    ci.registerSkill("source", { skillId: "s", proficiency: 0.9, exerciseCount: 10 });
    // No opt-in
    const result = ci.propagate("source", "target", "s");
    expect(result.success).toBe(false);
    // With opt-in
    ci.optIn("target", "s");
    const result2 = ci.propagate("source", "target", "s");
    expect(result2.success).toBe(true);
  });
});
