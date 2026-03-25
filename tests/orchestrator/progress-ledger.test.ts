import { describe, it, expect, beforeEach } from "vitest";
import { ProgressLedgerManager } from "../../src/orchestrator/progress-ledger.js";

describe("progress-ledger", () => {
  let manager: ProgressLedgerManager;

  beforeEach(() => {
    manager = new ProgressLedgerManager("task-1", "Build the login page");
  });

  describe("create(taskId, objective)", () => {
    it("should initialize with the given task_id and objective", () => {
      const ledger = manager.getLedger();

      expect(ledger.task_id).toBe("task-1");
      expect(ledger.objective).toBe("Build the login page");
    });

    it("should initialize with empty facts categories", () => {
      const ledger = manager.getLedger();

      expect(ledger.facts.given).toEqual([]);
      expect(ledger.facts.to_look_up).toEqual([]);
      expect(ledger.facts.to_derive).toEqual([]);
      expect(ledger.facts.educated_guesses).toEqual([]);
    });

    it("should initialize with empty plan and steps", () => {
      const ledger = manager.getLedger();

      expect(ledger.plan).toEqual([]);
      expect(ledger.steps_completed).toEqual([]);
      expect(ledger.current_step).toBeNull();
    });

    it("should initialize health fields to safe defaults", () => {
      const ledger = manager.getLedger();

      expect(ledger.is_request_satisfied).toBe(false);
      expect(ledger.is_in_loop).toBe(false);
      expect(ledger.is_progress_being_made).toBe(true);
      expect(ledger.confidence).toBe(0);
    });

    it("should initialize routing fields to null/empty", () => {
      const ledger = manager.getLedger();

      expect(ledger.next_speaker).toBeNull();
      expect(ledger.instruction).toBe("");
    });
  });

  describe("recordStep(step)", () => {
    it("should add a step to steps_completed", () => {
      manager.recordStep("Created login form component");

      const ledger = manager.getLedger();

      expect(ledger.steps_completed).toEqual(["Created login form component"]);
    });

    it("should accumulate multiple steps in order", () => {
      manager.recordStep("Step A");
      manager.recordStep("Step B");
      manager.recordStep("Step C");

      const ledger = manager.getLedger();

      expect(ledger.steps_completed).toEqual(["Step A", "Step B", "Step C"]);
    });
  });

  describe("checkHealth()", () => {
    it("should return is_in_loop false and is_progress_being_made true initially", () => {
      manager.recordStep("Step A");
      const health = manager.checkHealth();

      expect(health.is_in_loop).toBe(false);
      expect(health.is_progress_being_made).toBe(true);
    });

    it("should detect loop when the same action is repeated 3 times", () => {
      manager.recordStep("retry connection");
      manager.recordStep("retry connection");
      manager.recordStep("retry connection");

      const health = manager.checkHealth();

      expect(health.is_in_loop).toBe(true);
    });

    it("should not detect loop when fewer than 3 identical steps", () => {
      manager.recordStep("retry connection");
      manager.recordStep("retry connection");

      const health = manager.checkHealth();

      expect(health.is_in_loop).toBe(false);
    });

    it("should not detect loop when 3 steps are different", () => {
      manager.recordStep("step A");
      manager.recordStep("step B");
      manager.recordStep("step C");

      const health = manager.checkHealth();

      expect(health.is_in_loop).toBe(false);
    });

    it("should detect stall when no new steps for 3 consecutive checks", () => {
      manager.recordStep("initial step");

      manager.checkHealth(); // check 1 — progress (first step seen)
      manager.checkHealth(); // check 2 — no new steps
      const health = manager.checkHealth(); // check 3 — no new steps

      expect(health.is_progress_being_made).toBe(false);
    });

    it("should reset stall counter when a new step is recorded", () => {
      manager.recordStep("step 1");
      manager.checkHealth(); // check 1
      manager.checkHealth(); // check 2 — no new steps

      manager.recordStep("step 2"); // new progress
      const health = manager.checkHealth(); // check 3 — progress again

      expect(health.is_progress_being_made).toBe(true);
    });

    it("should update ledger health fields after check", () => {
      manager.recordStep("retry");
      manager.recordStep("retry");
      manager.recordStep("retry");

      manager.checkHealth();

      const ledger = manager.getLedger();
      expect(ledger.is_in_loop).toBe(true);
    });
  });

  describe("shouldEscalate()", () => {
    it("should return false initially", () => {
      expect(manager.shouldEscalate()).toBe(false);
    });

    it("should return true after 3 consecutive bad health checks (loop)", () => {
      manager.recordStep("retry");
      manager.recordStep("retry");
      manager.recordStep("retry");

      manager.checkHealth(); // bad (in loop)
      manager.checkHealth(); // bad (in loop)
      manager.checkHealth(); // bad (in loop)

      expect(manager.shouldEscalate()).toBe(true);
    });

    it("should return true after 3 consecutive bad health checks (stall)", () => {
      manager.recordStep("only step");

      manager.checkHealth(); // check 1 — progress (step count grew)
      manager.checkHealth(); // check 2 — no new steps (streak=1, still progressing)
      manager.checkHealth(); // check 3 — no new steps (streak=2, stall detected) — BAD
      manager.checkHealth(); // check 4 — still stalled — BAD
      manager.checkHealth(); // check 5 — still stalled — BAD

      expect(manager.shouldEscalate()).toBe(true);
    });

    it("should reset bad check counter when a good health check occurs", () => {
      manager.recordStep("retry");
      manager.recordStep("retry");
      manager.recordStep("retry");

      manager.checkHealth(); // bad (loop)
      manager.checkHealth(); // bad (loop)

      // Break the loop
      manager.recordStep("new approach");
      manager.checkHealth(); // good — resets counter

      expect(manager.shouldEscalate()).toBe(false);
    });

    it("should not escalate with only 2 consecutive bad checks", () => {
      manager.recordStep("retry");
      manager.recordStep("retry");
      manager.recordStep("retry");

      manager.checkHealth(); // bad
      manager.checkHealth(); // bad

      expect(manager.shouldEscalate()).toBe(false);
    });
  });

  describe("recordFact(category, fact)", () => {
    it("should add a fact to the given category", () => {
      manager.recordFact("given", "User must authenticate via OAuth");

      const ledger = manager.getLedger();

      expect(ledger.facts.given).toEqual(["User must authenticate via OAuth"]);
    });

    it("should add facts to to_look_up category", () => {
      manager.recordFact("to_look_up", "OAuth provider endpoints");

      const ledger = manager.getLedger();

      expect(ledger.facts.to_look_up).toEqual(["OAuth provider endpoints"]);
    });

    it("should add facts to to_derive category", () => {
      manager.recordFact("to_derive", "Token expiration strategy");

      const ledger = manager.getLedger();

      expect(ledger.facts.to_derive).toEqual(["Token expiration strategy"]);
    });

    it("should add facts to educated_guesses category", () => {
      manager.recordFact("educated_guesses", "Session timeout ~30 min");

      const ledger = manager.getLedger();

      expect(ledger.facts.educated_guesses).toEqual([
        "Session timeout ~30 min",
      ]);
    });

    it("should accumulate multiple facts in the same category", () => {
      manager.recordFact("given", "Fact A");
      manager.recordFact("given", "Fact B");

      const ledger = manager.getLedger();

      expect(ledger.facts.given).toEqual(["Fact A", "Fact B"]);
    });
  });

  describe("updatePlan(plan)", () => {
    it("should set the plan", () => {
      manager.updatePlan(["Step 1: Design", "Step 2: Implement"]);

      const ledger = manager.getLedger();

      expect(ledger.plan).toEqual(["Step 1: Design", "Step 2: Implement"]);
    });

    it("should replace the previous plan", () => {
      manager.updatePlan(["Old plan"]);
      manager.updatePlan(["New plan step 1", "New plan step 2"]);

      const ledger = manager.getLedger();

      expect(ledger.plan).toEqual(["New plan step 1", "New plan step 2"]);
    });
  });

  describe("setNextSpeaker(agent, instruction)", () => {
    it("should set next_speaker and instruction", () => {
      manager.setNextSpeaker("coder", "Implement the login form");

      const ledger = manager.getLedger();

      expect(ledger.next_speaker).toBe("coder");
      expect(ledger.instruction).toBe("Implement the login form");
    });

    it("should update when called again", () => {
      manager.setNextSpeaker("coder", "First task");
      manager.setNextSpeaker("reviewer", "Review the PR");

      const ledger = manager.getLedger();

      expect(ledger.next_speaker).toBe("reviewer");
      expect(ledger.instruction).toBe("Review the PR");
    });
  });

  describe("getLedger()", () => {
    it("should return the current ledger state", () => {
      manager.recordStep("Did a thing");
      manager.recordFact("given", "A known fact");
      manager.updatePlan(["Plan step 1"]);
      manager.setNextSpeaker("architect", "Design the system");

      const ledger = manager.getLedger();

      expect(ledger.task_id).toBe("task-1");
      expect(ledger.objective).toBe("Build the login page");
      expect(ledger.steps_completed).toEqual(["Did a thing"]);
      expect(ledger.facts.given).toEqual(["A known fact"]);
      expect(ledger.plan).toEqual(["Plan step 1"]);
      expect(ledger.next_speaker).toBe("architect");
      expect(ledger.instruction).toBe("Design the system");
    });

    it("should return a copy so mutations do not affect internal state", () => {
      const ledger = manager.getLedger();
      ledger.steps_completed.push("injected step");

      const fresh = manager.getLedger();
      expect(fresh.steps_completed).toEqual([]);
    });
  });
});
