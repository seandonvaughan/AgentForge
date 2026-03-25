import { describe, it, expect } from "vitest";
import { BENCHMARK_TASKS } from "../../src/benchmark/benchmark-tasks.js";
import { BENCHMARK_AGENTS, BENCHMARK_ARCHITECT, BENCHMARK_DEVELOPER, BENCHMARK_UTILITY } from "../../src/benchmark/benchmark-agents.js";

describe("Benchmark Tasks", () => {
  it("has exactly 10 tasks", () => {
    expect(BENCHMARK_TASKS).toHaveLength(10);
  });

  it("has unique task IDs", () => {
    const ids = BENCHMARK_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(10);
  });

  it("has unique task names", () => {
    const names = BENCHMARK_TASKS.map((t) => t.name);
    expect(new Set(names).size).toBe(10);
  });

  it("covers all three complexity tiers", () => {
    const complexities = new Set(BENCHMARK_TASKS.map((t) => t.complexity));
    expect(complexities).toEqual(new Set(["low", "medium", "high"]));
  });

  it("has 3 low, 4 medium, 3 high complexity tasks", () => {
    const counts = { low: 0, medium: 0, high: 0 };
    for (const task of BENCHMARK_TASKS) {
      counts[task.complexity]++;
    }
    expect(counts.low).toBe(3);
    expect(counts.medium).toBe(4);
    expect(counts.high).toBe(3);
  });

  it("all tasks have non-empty prompts", () => {
    for (const task of BENCHMARK_TASKS) {
      expect(task.prompt.length).toBeGreaterThan(20);
    }
  });
});

describe("Benchmark Agents", () => {
  it("has agents for all three tiers", () => {
    expect(BENCHMARK_AGENTS.opus).toBeDefined();
    expect(BENCHMARK_AGENTS.sonnet).toBeDefined();
    expect(BENCHMARK_AGENTS.haiku).toBeDefined();
  });

  it("architect is opus tier", () => {
    expect(BENCHMARK_ARCHITECT.model).toBe("opus");
    expect(BENCHMARK_ARCHITECT.category).toBe("strategic");
  });

  it("developer is sonnet tier", () => {
    expect(BENCHMARK_DEVELOPER.model).toBe("sonnet");
    expect(BENCHMARK_DEVELOPER.category).toBe("implementation");
  });

  it("utility is haiku tier", () => {
    expect(BENCHMARK_UTILITY.model).toBe("haiku");
    expect(BENCHMARK_UTILITY.category).toBe("utility");
  });

  it("all agents have valid AgentTemplate structure", () => {
    for (const agent of Object.values(BENCHMARK_AGENTS)) {
      expect(agent.name).toBeTruthy();
      expect(agent.version).toBe("3.0");
      expect(agent.system_prompt.length).toBeGreaterThan(10);
      expect(agent.skills.length).toBeGreaterThan(0);
      expect(agent.triggers).toBeDefined();
      expect(agent.collaboration).toBeDefined();
      expect(agent.context).toBeDefined();
    }
  });
});
