import type { ProgressLedger } from "../types/orchestration.js";

/**
 * Manages a {@link ProgressLedger} for a single task, providing
 * step recording, fact tracking, health checks (loop/stall detection),
 * and escalation logic.
 *
 * Inspired by AutoGen Magentic-One's progress-ledger pattern.
 */
export class ProgressLedgerManager {
  private ledger: ProgressLedger;

  /** Rolling history of health-check outcomes used by {@link shouldEscalate}. */
  private healthHistory: { in_loop: boolean; progressing: boolean }[] = [];

  /** Number of steps_completed at the time of the last {@link checkHealth} call. */
  private lastStepCount = 0;

  /** Consecutive checks with no new steps added. */
  private noProgressStreak = 0;

  constructor(taskId: string, objective: string) {
    this.ledger = {
      task_id: taskId,
      objective,

      facts: {
        given: [],
        to_look_up: [],
        to_derive: [],
        educated_guesses: [],
      },

      plan: [],
      steps_completed: [],
      current_step: null,

      is_request_satisfied: false,
      is_in_loop: false,
      is_progress_being_made: true,
      confidence: 0,

      next_speaker: null,
      instruction: "",
    };
  }

  /** Append a completed step to the ledger. */
  recordStep(step: string): void {
    this.ledger.steps_completed.push(step);
  }

  /** Add a fact to one of the four fact categories. */
  recordFact(category: keyof ProgressLedger["facts"], fact: string): void {
    this.ledger.facts[category].push(fact);
  }

  /** Replace the current plan with a new one. */
  updatePlan(plan: string[]): void {
    this.ledger.plan = [...plan];
  }

  /** Set the next agent to act and the instruction to give it. */
  setNextSpeaker(agent: string, instruction: string): void {
    this.ledger.next_speaker = agent;
    this.ledger.instruction = instruction;
  }

  /**
   * Evaluate the health of the current execution.
   *
   * - **Loop detection**: the last 3 steps in `steps_completed` are identical.
   * - **Progress detection**: no new steps were added since the previous call
   *   to `checkHealth()`. Three consecutive checks with no new steps triggers
   *   `is_progress_being_made = false`.
   *
   * Updates the ledger's health fields and records the result in the internal
   * health history (used by {@link shouldEscalate}).
   */
  checkHealth(): { is_in_loop: boolean; is_progress_being_made: boolean } {
    // --- Loop detection ---
    const steps = this.ledger.steps_completed;
    let inLoop = false;

    if (steps.length >= 3) {
      const last = steps[steps.length - 1];
      const secondLast = steps[steps.length - 2];
      const thirdLast = steps[steps.length - 3];
      inLoop = last === secondLast && secondLast === thirdLast;
    }

    // --- Progress / stall detection ---
    const currentStepCount = steps.length;

    if (currentStepCount > this.lastStepCount) {
      // New steps were recorded since the last check — reset streak.
      this.noProgressStreak = 0;
    } else {
      this.noProgressStreak += 1;
    }

    this.lastStepCount = currentStepCount;

    // Three consecutive checks with zero new steps → stall.
    const progressing = this.noProgressStreak < 2;

    // --- Update ledger ---
    this.ledger.is_in_loop = inLoop;
    this.ledger.is_progress_being_made = progressing;

    // --- Record in health history ---
    this.healthHistory.push({ in_loop: inLoop, progressing });

    return { is_in_loop: inLoop, is_progress_being_made: progressing };
  }

  /**
   * Returns `true` when health has been bad for 3 consecutive checks.
   *
   * A check is "bad" when `is_in_loop` is true **or**
   * `is_progress_being_made` is false.
   */
  shouldEscalate(): boolean {
    if (this.healthHistory.length < 3) {
      return false;
    }

    const lastThree = this.healthHistory.slice(-3);
    return lastThree.every((h) => h.in_loop || !h.progressing);
  }

  /**
   * Return a snapshot of the current ledger.
   *
   * The returned object is a shallow copy; mutating its arrays will not
   * affect the manager's internal state.
   */
  getLedger(): ProgressLedger {
    return {
      ...this.ledger,
      facts: {
        given: [...this.ledger.facts.given],
        to_look_up: [...this.ledger.facts.to_look_up],
        to_derive: [...this.ledger.facts.to_derive],
        educated_guesses: [...this.ledger.facts.educated_guesses],
      },
      plan: [...this.ledger.plan],
      steps_completed: [...this.ledger.steps_completed],
    };
  }
}
