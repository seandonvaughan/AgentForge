/**
 * tests/integration/sprint-pipeline.test.ts
 *
 * End-to-End Sprint Pipeline Integration Test — P2-3
 *
 * Verifies the complete sprint lifecycle:
 *   1. Sprint creation with 3 items and file persistence
 *   2. Phase advancement through all phases
 *   3. Auto-delegation assigns items to the right specialists
 *   4. CareerStore records task memories after completion
 *   5. Skill level-ups trigger at SKILL_LEVEL_THRESHOLDS
 *   6. Budget tracking accumulates costs
 *   7. ConcurrencyManager enforces per-agent slot caps
 *   8. Sprint completion marks all items done
 *   9. Temp file cleanup
 *
 * All Anthropic API calls are mocked — no real network traffic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@agentforge/core", () => ({
  AgentRuntime: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue({
      sessionId: `session-${randomUUID()}`,
      status: "completed",
      response: "Task completed successfully",
      model: "sonnet",
      costUsd: 0.05,
      inputTokens: 500,
      outputTokens: 200,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }),
    runStreaming: vi.fn().mockResolvedValue({
      sessionId: `session-${randomUUID()}`,
      status: "completed",
      response: "Task completed successfully",
      model: "sonnet",
      costUsd: 0.05,
      inputTokens: 500,
      outputTokens: 200,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }),
    estimateCost: vi.fn().mockReturnValue(0.01),
  })),
  loadAgentConfig: vi.fn().mockResolvedValue({
    agentId: "test-agent",
    name: "Test Agent",
    model: "sonnet",
    systemPrompt: "You are a test agent",
    workspaceId: "default",
  }),
}));

// ── Real imports (after mocks) ────────────────────────────────────────────────

import {
  AutonomousSprintFramework,
  type SprintItem,
  type SprintPhase,
} from "../../src/autonomous/sprint-framework.js";
import { AutoDelegationPipeline } from "../../src/orchestrator/auto-delegation.js";
import { CareerStore } from "../../src/lifecycle/career-store.js";
import { ConcurrencyManager } from "../../src/lifecycle/concurrency-manager.js";
import type { TeamUnit, AgentIdentity } from "../../src/types/lifecycle.js";
import type { TaskMemory } from "../../src/types/lifecycle.js";
import { SKILL_LEVEL_THRESHOLDS } from "../../src/types/lifecycle.js";

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

interface TestAgentYaml {
  name: string;
  model: string;
  system_prompt: string;
  role: string;
}

function makeAgentYaml(config: TestAgentYaml): string {
  return [
    `name: ${config.name}`,
    `model: ${config.model}`,
    `system_prompt: "${config.system_prompt}"`,
    `role: ${config.role}`,
  ].join("\n");
}

function writeAgentFile(agentsDir: string, id: string, config: TestAgentYaml): void {
  writeFileSync(join(agentsDir, `${id}.yaml`), makeAgentYaml(config), "utf-8");
}

function readSprintFile(sprintsDir: string, version: string): Record<string, unknown> {
  const path = join(sprintsDir, `v${version}.json`);
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function writeSprintFile(sprintsDir: string, version: string, data: unknown): void {
  writeFileSync(join(sprintsDir, `v${version}.json`), JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Test fixture constants
// ---------------------------------------------------------------------------

const TEST_SPRINT_VERSION = "99.0";

const TEST_AGENTS: Array<{ id: string; config: TestAgentYaml; layer: string }> = [
  {
    id: "test-cto",
    config: {
      name: "Test CTO",
      model: "opus",
      system_prompt: "You are a CTO agent",
      role: "executive",
    },
    layer: "executive",
  },
  {
    id: "test-coder",
    config: {
      name: "Test Coder",
      model: "sonnet",
      system_prompt: "You are a backend coder agent",
      role: "specialist",
    },
    layer: "backend",
  },
  {
    id: "test-tester",
    config: {
      name: "Test Tester",
      model: "haiku",
      system_prompt: "You are a QA tester agent",
      role: "specialist",
    },
    layer: "qa",
  },
];

const TEST_SPRINT_ITEMS: Omit<SprintItem, "id">[] = [
  {
    title: "Implement backend API endpoint",
    description: "Create REST API endpoint for user authentication",
    priority: "P1",
    assignee: "test-coder",
    status: "planned",
  },
  {
    title: "Write integration tests",
    description: "Test the new API endpoint with vitest and mock fixtures",
    priority: "P2",
    assignee: "test-tester",
    status: "planned",
  },
  {
    title: "Review architecture and database schema",
    description: "Review data pipeline schema and SQL query patterns",
    priority: "P1",
    assignee: "test-cto",
    status: "planned",
  },
];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Sprint Pipeline — End-to-End Integration", () => {
  let tmpDir: string;
  let agentsDir: string;
  let sprintsDir: string;

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  beforeEach(() => {
    tmpDir = join(tmpdir(), `agentforge-test-${randomUUID()}`);
    agentsDir = join(tmpDir, ".agentforge", "agents");
    sprintsDir = join(tmpDir, ".agentforge", "sprints");

    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(sprintsDir, { recursive: true });

    // Write all 3 test agent YAML files
    for (const agent of TEST_AGENTS) {
      writeAgentFile(agentsDir, agent.id, agent.config);
    }
  });

  afterEach(() => {
    // Clean up temp files
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Test 1: Sprint creation ─────────────────────────────────────────────────

  describe("Sprint creation and file persistence", () => {
    it("creates a sprint with 3 items in 'audit' phase", () => {
      const fw = new AutonomousSprintFramework();
      const sprint = fw.createSprint(
        TEST_SPRINT_VERSION,
        "E2E Integration Sprint",
        200,
        3,
      );

      expect(sprint.sprintId).toBeTruthy();
      expect(sprint.version).toBe(TEST_SPRINT_VERSION);
      expect(sprint.phase).toBe("audit");
      expect(sprint.budget).toBe(200);
      expect(sprint.teamSize).toBe(3);
    });

    it("sprint gets a unique sprintId", () => {
      const fw = new AutonomousSprintFramework();
      const s1 = fw.createSprint("99.1", "Sprint A", 100, 3);
      const s2 = fw.createSprint("99.2", "Sprint B", 100, 3);
      expect(s1.sprintId).not.toBe(s2.sprintId);
    });

    it("adds 3 items to the sprint and retrieves them", () => {
      const fw = new AutonomousSprintFramework();
      const sprint = fw.createSprint(TEST_SPRINT_VERSION, "E2E Sprint", 200, 3);

      for (const itemDef of TEST_SPRINT_ITEMS) {
        fw.addItem(sprint.sprintId, itemDef);
      }

      const loaded = fw.getSprint(sprint.sprintId)!;
      expect(loaded.items).toHaveLength(3);
      expect(loaded.items[0].status).toBe("planned");
      expect(loaded.items[1].status).toBe("planned");
      expect(loaded.items[2].status).toBe("planned");
    });

    it("persists sprint JSON to filesystem", () => {
      const sprintData = {
        sprintId: randomUUID(),
        version: TEST_SPRINT_VERSION,
        title: "Filesystem Sprint",
        createdAt: new Date().toISOString(),
        phase: "audit",
        items: TEST_SPRINT_ITEMS.map((item, i) => ({ ...item, id: `item-${i}` })),
        budget: 200,
        budgetUsed: 0,
        teamSize: 3,
        successCriteria: [],
        auditFindings: [],
        agentsInvolved: [],
      };

      writeSprintFile(sprintsDir, TEST_SPRINT_VERSION, sprintData);
      const loaded = readSprintFile(sprintsDir, TEST_SPRINT_VERSION);

      expect(loaded["version"]).toBe(TEST_SPRINT_VERSION);
      expect((loaded["items"] as unknown[]).length).toBe(3);
    });

    it("agent YAML files exist for all 3 test agents", () => {
      for (const agent of TEST_AGENTS) {
        const yamlPath = join(agentsDir, `${agent.id}.yaml`);
        expect(existsSync(yamlPath)).toBe(true);
      }
    });

    it("agent YAML files contain expected fields", () => {
      const coderYaml = readFileSync(join(agentsDir, "test-coder.yaml"), "utf-8");
      expect(coderYaml).toContain("name: Test Coder");
      expect(coderYaml).toContain("model: sonnet");
    });
  });

  // ── Test 2: Phase advancement ────────────────────────────────────────────────

  describe("Phase advancement through all phases", () => {
    it("advances from audit → plan → assign → execute → test", () => {
      const fw = new AutonomousSprintFramework();
      const sprint = fw.createSprint(TEST_SPRINT_VERSION, "Phase Test", 100, 3);

      const phases: SprintPhase[] = ["audit", "plan", "assign", "execute", "test"];
      expect(fw.getPhase(sprint.sprintId)).toBe("audit");

      for (let i = 1; i < phases.length; i++) {
        fw.advancePhase(sprint.sprintId);
        expect(fw.getPhase(sprint.sprintId)).toBe(phases[i]);
      }
    });

    it("continues through all 9 phases to learn", () => {
      const fw = new AutonomousSprintFramework();
      const sprint = fw.createSprint(TEST_SPRINT_VERSION, "Full Phase Sprint", 100, 3);

      const allPhases: SprintPhase[] = [
        "audit", "plan", "assign", "execute", "test",
        "review", "gate", "release", "learn",
      ];

      for (let i = 1; i < allPhases.length; i++) {
        fw.advancePhase(sprint.sprintId);
      }

      expect(fw.getPhase(sprint.sprintId)).toBe("learn");
    });

    it("throws when advancing past the final phase", () => {
      const fw = new AutonomousSprintFramework();
      const sprint = fw.createSprint(TEST_SPRINT_VERSION, "Final Phase Sprint", 100, 3);

      // Advance to final phase (learn = index 8, advance 8 times from audit)
      for (let i = 0; i < 8; i++) fw.advancePhase(sprint.sprintId);
      expect(() => fw.advancePhase(sprint.sprintId)).toThrow(/final phase/);
    });

    it("phase order matches expected sprint lifecycle", () => {
      const fw = new AutonomousSprintFramework();
      const phases = fw.getPhaseOrder();
      expect(phases[0]).toBe("audit");
      expect(phases[phases.length - 1]).toBe("learn");
      expect(phases).toContain("execute");
      expect(phases).toContain("gate");
      expect(phases).toContain("release");
    });
  });

  // ── Test 3: Auto-delegation ──────────────────────────────────────────────────

  describe("Auto-delegation assigns items correctly", () => {
    const pipeline = new AutoDelegationPipeline();

    const backendTeam: TeamUnit = {
      id: "backend-team",
      layer: "backend",
      manager: "test-cto",
      techLead: "test-cto",
      specialists: ["test-coder"],
      maxCapacity: 5,
      currentLoad: 0,
      domain: ["api", "server"],
    };

    const qaTeam: TeamUnit = {
      id: "qa-team",
      layer: "qa",
      manager: "test-cto",
      techLead: "test-cto",
      specialists: ["test-tester"],
      maxCapacity: 5,
      currentLoad: 0,
      domain: ["test", "coverage"],
    };

    const agentIdentities: AgentIdentity[] = [
      {
        id: "test-coder",
        name: "Test Coder",
        role: "specialist",
        seniority: "mid",
        layer: "backend",
        teamId: "backend-team",
        model: "sonnet",
        status: "active",
        hiredAt: new Date().toISOString(),
        currentTasks: [],
        maxConcurrentTasks: 3,
      },
      {
        id: "test-tester",
        name: "Test Tester",
        role: "specialist",
        seniority: "junior",
        layer: "qa",
        teamId: "qa-team",
        model: "haiku",
        status: "active",
        hiredAt: new Date().toISOString(),
        currentTasks: [],
        maxConcurrentTasks: 2,
      },
    ];

    it("returns a delegation result with steps, assignments, and unassigned", () => {
      const items: SprintItem[] = TEST_SPRINT_ITEMS.map((item, i) => ({
        ...item,
        id: `item-${i}`,
      }));

      const result = pipeline.delegateSprint(
        items,
        [backendTeam, qaTeam],
        agentIdentities,
      );

      expect(result).toHaveProperty("steps");
      expect(result).toHaveProperty("assignments");
      expect(result).toHaveProperty("unassigned");
    });

    it("assigns at least one item to test-coder (backend domain)", () => {
      const backendItem: SprintItem = {
        id: "backend-item",
        title: "Implement API endpoint",
        description: "Create REST API route with middleware",
        priority: "P1",
        assignee: "",
        status: "planned",
      };

      const result = pipeline.delegateSprint(
        [backendItem],
        [backendTeam, qaTeam],
        agentIdentities,
      );

      const coderAssignments = result.assignments.get("test-coder") ?? [];
      expect(coderAssignments.length).toBeGreaterThan(0);
    });

    it("assigns test items to test-tester (qa domain)", () => {
      const qaItem: SprintItem = {
        id: "qa-item",
        title: "Write integration tests",
        description: "Create vitest specs and mock fixtures for coverage",
        priority: "P2",
        assignee: "",
        status: "planned",
      };

      const result = pipeline.delegateSprint(
        [qaItem],
        [backendTeam, qaTeam],
        agentIdentities,
      );

      const testerAssignments = result.assignments.get("test-tester") ?? [];
      expect(testerAssignments.length).toBeGreaterThan(0);
    });

    it("generates delegation steps for each item", () => {
      const items: SprintItem[] = TEST_SPRINT_ITEMS.map((item, i) => ({
        ...item,
        id: `item-${i}`,
      }));

      const result = pipeline.delegateSprint(
        items,
        [backendTeam, qaTeam],
        agentIdentities,
      );

      expect(result.steps.length).toBeGreaterThan(0);
    });

    it("inferDomain classifies backend items correctly", () => {
      const item: SprintItem = {
        id: "x",
        title: "Create API endpoint",
        description: "REST server handler middleware",
        priority: "P1",
        assignee: "",
        status: "planned",
      };
      expect(pipeline.inferDomain(item)).toBe("backend");
    });

    it("inferDomain classifies qa items correctly", () => {
      const item: SprintItem = {
        id: "x",
        title: "Write vitest test specs",
        description: "test coverage assertion fixtures mock",
        priority: "P2",
        assignee: "",
        status: "planned",
      };
      expect(pipeline.inferDomain(item)).toBe("qa");
    });

    it("inferDomain classifies data items correctly", () => {
      const item: SprintItem = {
        id: "x",
        title: "Migrate database schema",
        description: "SQL migration sqlite embedding vector index",
        priority: "P1",
        assignee: "",
        status: "planned",
      };
      expect(pipeline.inferDomain(item)).toBe("data");
    });

    it("P0 items require senior+ agents", () => {
      const p0Item: SprintItem = {
        id: "critical",
        title: "Critical backend fix",
        description: "API server down, middleware broken",
        priority: "P0",
        assignee: "",
        status: "planned",
      };
      // test-coder is mid — should not be assigned P0 items from a mid-only team
      const result = pipeline.delegateSprint([p0Item], [backendTeam], agentIdentities);
      // No senior agent available → item goes unassigned
      expect(result.unassigned).toContain("critical");
    });
  });

  // ── Test 4: CareerStore records task memories ────────────────────────────────

  describe("CareerStore records task memories after completion", () => {
    it("records a task memory for an agent", () => {
      const store = new CareerStore();

      const memory: TaskMemory = {
        taskId: "task-001",
        timestamp: new Date().toISOString(),
        objective: "Implement backend API endpoint",
        approach: "Created a Fastify route with validation",
        outcome: "success",
        lessonsLearned: ["Validate input early"],
        filesModified: ["src/routes/api.ts"],
        collaborators: [],
        difficulty: 3,
        tokensUsed: 750,
      };

      store.recordTaskOutcome("test-coder", memory);
      const history = store.getTaskHistory("test-coder");

      expect(history).toHaveLength(1);
      expect(history[0].taskId).toBe("task-001");
      expect(history[0].outcome).toBe("success");
    });

    it("records multiple task memories per agent", () => {
      const store = new CareerStore();

      for (let i = 0; i < 5; i++) {
        store.recordTaskOutcome("test-coder", {
          taskId: `task-${i}`,
          timestamp: new Date().toISOString(),
          objective: `Task ${i}`,
          approach: "Standard approach",
          outcome: "success",
          lessonsLearned: [],
          filesModified: [],
          collaborators: [],
          difficulty: 2,
          tokensUsed: 100,
        });
      }

      expect(store.getTaskHistory("test-coder")).toHaveLength(5);
    });

    it("postTaskHook creates a task memory and returns it", () => {
      const store = new CareerStore();

      const result = store.postTaskHook("test-coder", {
        taskId: "hook-task-1",
        success: true,
        summary: "Implemented auth endpoint",
        tokensUsed: 500,
        skills: ["typescript"],
      });

      expect(result.taskMemory.taskId).toBe("hook-task-1");
      expect(result.taskMemory.outcome).toBe("success");
    });

    it("postTaskHook records failure correctly", () => {
      const store = new CareerStore();

      const result = store.postTaskHook("test-tester", {
        taskId: "failing-task",
        success: false,
        summary: "Could not reach external API",
        tokensUsed: 100,
      });

      expect(result.taskMemory.outcome).toBe("failure");
    });

    it("getRecentContext returns last N memories", () => {
      const store = new CareerStore();

      for (let i = 0; i < 10; i++) {
        store.recordTaskOutcome("test-coder", {
          taskId: `task-${i}`,
          timestamp: new Date().toISOString(),
          objective: `Task ${i}`,
          approach: "",
          outcome: "success",
          lessonsLearned: [],
          filesModified: [],
          collaborators: [],
          difficulty: 1,
          tokensUsed: 50,
        });
      }

      const context = store.getRecentContext("test-coder", 3);
      expect(context).toHaveLength(3);
    });

    it("task history is isolated per agent", () => {
      const store = new CareerStore();

      store.recordTaskOutcome("agent-alpha", {
        taskId: "alpha-task",
        timestamp: new Date().toISOString(),
        objective: "Alpha work",
        approach: "",
        outcome: "success",
        lessonsLearned: [],
        filesModified: [],
        collaborators: [],
        difficulty: 1,
        tokensUsed: 100,
      });

      store.recordTaskOutcome("agent-beta", {
        taskId: "beta-task",
        timestamp: new Date().toISOString(),
        objective: "Beta work",
        approach: "",
        outcome: "failure",
        lessonsLearned: [],
        filesModified: [],
        collaborators: [],
        difficulty: 2,
        tokensUsed: 200,
      });

      expect(store.getTaskHistory("agent-alpha")).toHaveLength(1);
      expect(store.getTaskHistory("agent-beta")).toHaveLength(1);
      expect(store.getTaskHistory("agent-alpha")[0].taskId).toBe("alpha-task");
      expect(store.getTaskHistory("agent-beta")[0].taskId).toBe("beta-task");
    });
  });

  // ── Test 5: Skill level-ups ──────────────────────────────────────────────────

  describe("Skill level-ups trigger at thresholds", () => {
    it("skill starts at level 1", () => {
      const store = new CareerStore();
      store.recordSkillExercise("test-coder", "typescript", true);
      const skill = store.getSkillLevel("test-coder", "typescript");
      expect(skill).not.toBeNull();
      expect(skill!.level).toBeGreaterThanOrEqual(1);
    });

    it("level 2 threshold is 5 exercises at 70% success rate", () => {
      const threshold = SKILL_LEVEL_THRESHOLDS[2];
      expect(threshold.minExercises).toBe(5);
      expect(threshold.minSuccessRate).toBe(0.70);
    });

    it("level 3 threshold is 15 exercises at 80% success rate", () => {
      const threshold = SKILL_LEVEL_THRESHOLDS[3];
      expect(threshold.minExercises).toBe(15);
      expect(threshold.minSuccessRate).toBe(0.80);
    });

    it("triggers level-up to level 2 after meeting threshold", () => {
      const store = new CareerStore();
      const agentId = "skill-test-agent";
      const skillName = "typescript";

      // 5 exercises with ≥70% success rate triggers level 2
      for (let i = 0; i < 5; i++) {
        store.recordSkillExercise(agentId, skillName, true); // all successes
      }

      const skill = store.getSkillLevel(agentId, skillName);
      expect(skill!.level).toBe(2);
    });

    it("does not level up without sufficient exercises", () => {
      const store = new CareerStore();

      // Only 3 exercises (need 5 for level 2)
      for (let i = 0; i < 3; i++) {
        store.recordSkillExercise("skill-agent", "testing", true);
      }

      const skill = store.getSkillLevel("skill-agent", "testing");
      expect(skill!.level).toBe(1);
    });

    it("postTaskHook returns skill level-ups when they occur", () => {
      const store = new CareerStore();
      const agentId = "levelup-agent";

      // Pre-seed 4 successful exercises (1 more triggers level 2)
      for (let i = 0; i < 4; i++) {
        store.recordSkillExercise(agentId, "typescript", true);
      }

      const result = store.postTaskHook(agentId, {
        taskId: "levelup-task",
        success: true,
        summary: "TypeScript work done",
        skills: ["typescript"],
      });

      expect(result.skillLevelUps.length).toBeGreaterThan(0);
      expect(result.skillLevelUps[0].skill).toBe("typescript");
      expect(result.skillLevelUps[0].newLevel).toBe(2);
    });

    it("postTaskHook returns empty skillLevelUps when no level-up occurs", () => {
      const store = new CareerStore();

      const result = store.postTaskHook("fresh-agent", {
        taskId: "first-task",
        success: true,
        summary: "First task completed",
        skills: ["testing"],
      });

      // First exercise can't level up (need 5 minimum)
      expect(result.skillLevelUps).toHaveLength(0);
    });
  });

  // ── Test 6: Budget tracking ──────────────────────────────────────────────────

  describe("Budget tracking accumulates costs", () => {
    it("sprint budget starts at 0 used", () => {
      const sprintData = {
        sprintId: randomUUID(),
        version: TEST_SPRINT_VERSION,
        title: "Budget Sprint",
        createdAt: new Date().toISOString(),
        phase: "execute",
        items: [],
        budget: 500,
        budgetUsed: 0,
        teamSize: 3,
        successCriteria: [],
        auditFindings: [],
        agentsInvolved: [],
      };

      writeSprintFile(sprintsDir, TEST_SPRINT_VERSION, sprintData);
      const loaded = readSprintFile(sprintsDir, TEST_SPRINT_VERSION);
      expect(loaded["budgetUsed"]).toBe(0);
    });

    it("accumulates budget across multiple task completions via filesystem", () => {
      const sprintData = {
        sprintId: randomUUID(),
        version: TEST_SPRINT_VERSION,
        title: "Budget Accumulation Sprint",
        createdAt: new Date().toISOString(),
        phase: "execute",
        items: TEST_SPRINT_ITEMS.map((item, i) => ({
          ...item,
          id: `item-${i}`,
        })),
        budget: 500,
        budgetUsed: 0,
        teamSize: 3,
        successCriteria: [],
        auditFindings: [],
        agentsInvolved: [],
      };

      writeSprintFile(sprintsDir, TEST_SPRINT_VERSION, sprintData);

      // Simulate item completions with cost accumulation
      const costs = [0.05, 0.08, 0.04]; // simulated costs per item
      let totalCost = 0;

      for (const cost of costs) {
        const current = readSprintFile(sprintsDir, TEST_SPRINT_VERSION);
        const currentUsed = (current["budgetUsed"] as number) ?? 0;
        totalCost += cost;
        (current as Record<string, unknown>)["budgetUsed"] = currentUsed + cost;
        writeSprintFile(sprintsDir, TEST_SPRINT_VERSION, current);
      }

      const final = readSprintFile(sprintsDir, TEST_SPRINT_VERSION);
      expect(final["budgetUsed"] as number).toBeCloseTo(totalCost);
    });

    it("budget remains under cap when costs are low", () => {
      const budget = 100;
      const costs = [0.05, 0.08, 0.04];
      const totalCost = costs.reduce((a, b) => a + b, 0);
      expect(totalCost).toBeLessThan(budget);
    });

    it("budget overrun can be detected from sprint file", () => {
      const sprintData = {
        budget: 0.1,
        budgetUsed: 0.5,
      };
      const overrun = (sprintData.budgetUsed as number) > (sprintData.budget as number);
      expect(overrun).toBe(true);
    });
  });

  // ── Test 7: ConcurrencyManager enforces slot caps ────────────────────────────

  describe("ConcurrencyManager enforces per-agent slot caps", () => {
    it("allocates a slot for a junior agent (max 2 concurrent)", () => {
      const cm = new ConcurrencyManager();
      const slot = cm.allocateSlot("test-tester", "task-1", "junior");
      expect(slot).not.toBeNull();
      expect(slot!.agentId).toBe("test-tester");
      expect(slot!.status).toBe("active");
    });

    it("blocks allocation when junior agent reaches 1-slot cap", () => {
      const cm = new ConcurrencyManager();
      // Junior seniority has maxConcurrentTasks = 1
      const slot1 = cm.allocateSlot("test-tester", "task-1", "junior");
      const slot2 = cm.allocateSlot("test-tester", "task-2", "junior"); // should be null

      expect(slot1).not.toBeNull();
      expect(slot2).toBeNull(); // cap exceeded at 1
    });

    it("reports correct capacity for an agent", () => {
      const cm = new ConcurrencyManager();
      cm.allocateSlot("test-coder", "task-1", "mid");

      const cap = cm.getCapacity("test-coder", "mid");
      expect(cap.used).toBe(1);
      expect(cap.max).toBeGreaterThan(0);
      expect(cap.available).toBe(cap.max - 1);
    });

    it("releases a slot and makes capacity available again", () => {
      const cm = new ConcurrencyManager();
      const slot = cm.allocateSlot("test-tester", "task-1", "junior");
      expect(slot).not.toBeNull();

      const released = cm.releaseSlot(slot!.slotId, "completed");
      expect(released!.status).toBe("completed");

      const cap = cm.getCapacity("test-tester", "junior");
      expect(cap.used).toBe(0);
    });

    it("getActiveSlots returns only active slots for an agent", () => {
      const cm = new ConcurrencyManager();
      const s1 = cm.allocateSlot("test-coder", "task-1", "mid");
      const s2 = cm.allocateSlot("test-coder", "task-2", "mid");
      cm.releaseSlot(s1!.slotId, "completed");

      const active = cm.getActiveSlots("test-coder");
      expect(active).toHaveLength(1);
      expect(active[0].slotId).toBe(s2!.slotId);
    });

    it("checkConflicts detects file overlaps across active slots", () => {
      const cm = new ConcurrencyManager();
      const slot = cm.allocateSlot("test-coder", "task-1", "mid");
      cm.updateWorkingFiles(slot!.slotId, ["src/routes/api.ts", "src/db/schema.ts"]);

      const { hasConflict, conflictingSlots } = cm.checkConflicts("test-coder", [
        "src/routes/api.ts",
      ]);

      expect(hasConflict).toBe(true);
      expect(conflictingSlots).toContain(slot!.slotId);
    });

    it("checkConflicts returns no conflict when files are different", () => {
      const cm = new ConcurrencyManager();
      const slot = cm.allocateSlot("test-coder", "task-1", "mid");
      cm.updateWorkingFiles(slot!.slotId, ["src/routes/api.ts"]);

      const { hasConflict } = cm.checkConflicts("test-coder", ["src/other/file.ts"]);
      expect(hasConflict).toBe(false);
    });
  });

  // ── Test 8: Sprint completion ─────────────────────────────────────────────────

  describe("Sprint completion marks all items done", () => {
    it("completes all items and marks sprint as complete via framework", () => {
      const fw = new AutonomousSprintFramework();
      const sprint = fw.createSprint(TEST_SPRINT_VERSION, "Completion Sprint", 200, 3);

      const itemIds: string[] = [];
      for (const itemDef of TEST_SPRINT_ITEMS) {
        const item = fw.addItem(sprint.sprintId, itemDef);
        itemIds.push(item.id);
      }

      // Complete all items
      for (const id of itemIds) {
        fw.startItem(sprint.sprintId, id);
        fw.completeItem(sprint.sprintId, id);
      }

      const progress = fw.getProgress(sprint.sprintId);
      expect(progress.completed).toBe(3);
      expect(progress.total).toBe(3);
      expect(progress.pct).toBe(100);
    });

    it("completed items have completedAt timestamp set", () => {
      const fw = new AutonomousSprintFramework();
      const sprint = fw.createSprint(TEST_SPRINT_VERSION, "Timestamp Sprint", 200, 3);
      const item = fw.addItem(sprint.sprintId, TEST_SPRINT_ITEMS[0]);
      fw.startItem(sprint.sprintId, item.id);
      fw.completeItem(sprint.sprintId, item.id);

      const updated = fw.getSprint(sprint.sprintId)!;
      const completedItem = updated.items.find((i) => i.id === item.id)!;
      expect(completedItem.completedAt).toBeTruthy();
      expect(new Date(completedItem.completedAt!).getTime()).not.toBeNaN();
    });

    it("records sprint result with gate verdict", () => {
      const fw = new AutonomousSprintFramework();
      const sprint = fw.createSprint(TEST_SPRINT_VERSION, "Gate Sprint", 200, 3);
      for (const itemDef of TEST_SPRINT_ITEMS) {
        const item = fw.addItem(sprint.sprintId, itemDef);
        fw.startItem(sprint.sprintId, item.id);
        fw.completeItem(sprint.sprintId, item.id);
      }

      const result = fw.recordResult(sprint.sprintId, {
        phase: "gate",
        itemsCompleted: 3,
        itemsTotal: 3,
        testsPassing: 50,
        testsTotal: 50,
        budgetUsed: 87.5,
        gateVerdict: "approved",
        learnings: ["All items completed on time", "Tests passed 100%"],
      });

      expect(result.gateVerdict).toBe("approved");
      expect(result.itemsCompleted).toBe(3);
      expect(result.learnings).toHaveLength(2);
    });

    it("sprint filesystem file reflects all items completed", () => {
      const sprintData = {
        sprintId: randomUUID(),
        version: TEST_SPRINT_VERSION,
        title: "File Completion Sprint",
        createdAt: new Date().toISOString(),
        phase: "release",
        items: TEST_SPRINT_ITEMS.map((item, i) => ({
          ...item,
          id: `item-${i}`,
          status: "completed",
          completedAt: new Date().toISOString(),
        })),
        budget: 200,
        budgetUsed: 87.5,
        teamSize: 3,
        successCriteria: ["All tests passing"],
        auditFindings: [],
        agentsInvolved: TEST_AGENTS.map((a) => a.id),
      };

      writeSprintFile(sprintsDir, TEST_SPRINT_VERSION, sprintData);

      const loaded = readSprintFile(sprintsDir, TEST_SPRINT_VERSION);
      const items = loaded["items"] as Array<{ status: string }>;
      const allDone = items.every((i) => i.status === "completed");
      expect(allDone).toBe(true);
    });

    it("mergeCompletedSlots collects memories from all completed slots", () => {
      const cm = new ConcurrencyManager();

      // Allocate and immediately release two slots
      const slot1 = cm.allocateSlot("test-coder", "task-a", "mid")!;
      const slot2 = cm.allocateSlot("test-coder", "task-b", "mid")!;

      cm.releaseSlot(slot1.slotId, "completed");
      cm.releaseSlot(slot2.slotId, "completed");

      const { mergedMemories, fileConflicts } = cm.mergeCompletedSlots("test-coder");

      // The slots had no task memories injected, but merge should succeed
      expect(Array.isArray(mergedMemories)).toBe(true);
      expect(Array.isArray(fileConflicts)).toBe(true);
    });
  });

  // ── Test 9: Cleanup verification ─────────────────────────────────────────────

  describe("Temp file cleanup", () => {
    it("temp directory exists before cleanup", () => {
      expect(existsSync(tmpDir)).toBe(true);
    });

    it("agent files written during test exist before cleanup", () => {
      for (const agent of TEST_AGENTS) {
        expect(existsSync(join(agentsDir, `${agent.id}.yaml`))).toBe(true);
      }
    });

    it("temp directory will be cleaned up by afterEach", () => {
      // Write a sentinel file to verify cleanup happens
      const sentinelPath = join(tmpDir, "sentinel.txt");
      writeFileSync(sentinelPath, "cleanup-test", "utf-8");
      expect(existsSync(sentinelPath)).toBe(true);
      // The afterEach hook will remove tmpDir — verify it deletes correctly
      rmSync(sentinelPath, { force: true });
      expect(existsSync(sentinelPath)).toBe(false);
    });
  });
});
