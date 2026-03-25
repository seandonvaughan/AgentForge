/**
 * Control Loop for the AgentForge Orchestrator.
 *
 * Orchestrates one full agent execution cycle using existing v3 runtime components.
 * The loop runs iterations until it reaches a terminal condition:
 * - completed (request satisfied or no more speakers)
 * - max_iterations (iteration limit reached)
 * - loop_detected (LoopGuard total_actions limit exceeded)
 * - no_progress (stall_count exceeds threshold)
 * - budget_exhausted (session budget exceeded)
 */

import type { AgentTemplate } from "../types/agent.js";
import type { ProgressLedger } from "../types/orchestration.js";
import { AgentForgeSession } from "./session.js";
import { LoopGuard } from "./loop-guard.js";
import { ProgressLedgerManager } from "./progress-ledger.js";

// ---------------------------------------------------------------------------
// Config & Result Types
// ---------------------------------------------------------------------------

export interface ControlLoopConfig {
  /** Maximum number of iterations to run. Defaults to 20. */
  maxIterations: number;
  /** Path to the project root. */
  projectRoot: string;
  /** Optional session budget in USD. */
  sessionBudgetUsd?: number;
}

export type ControlLoopExitReason =
  | "completed"
  | "max_iterations"
  | "budget_exhausted"
  | "loop_detected"
  | "no_progress";

export interface ControlLoopResult {
  /** The reason why the loop exited. */
  exitReason: ControlLoopExitReason;
  /** Number of iterations that were run. */
  iterationsRun: number;
  /** The ledger state at exit. */
  finalLedger?: ProgressLedger;
}

// ---------------------------------------------------------------------------
// ControlLoop
// ---------------------------------------------------------------------------

/**
 * Bounded execution loop controller that orchestrates one full agent execution
 * cycle using existing v3 runtime components.
 *
 * The loop body:
 * 1. Check if iterations >= maxIterations → exit "max_iterations"
 * 2. Increment LoopGuard total_actions → if blocked, exit "loop_detected"
 * 3. Get ledger from ProgressLedgerManager
 * 4. Check if is_request_satisfied → exit "completed"
 * 5. Check stall_count (from checkHealth) → if > threshold, exit "no_progress"
 * 6. Select next speaker via session.selectNextSpeaker()
 * 7. If no speaker, exit "completed"
 * 8. Run agent via session.runAgent()
 * 9. Update ledger (checkHealth)
 * 10. Increment iteration counter and loop
 */
export class ControlLoop {
  private readonly loopGuard: LoopGuard;
  private readonly ledgerManager: ProgressLedgerManager;

  constructor(
    private readonly session: AgentForgeSession,
    private readonly agents: AgentTemplate[],
    private readonly config: ControlLoopConfig,
  ) {
    this.loopGuard = new LoopGuard();
    this.ledgerManager = new ProgressLedgerManager(
      "control-loop-task",
      config.projectRoot,
    );
  }

  /**
   * Run the bounded execution loop.
   *
   * Executes until a terminal condition is met (completed, max_iterations,
   * loop_detected, no_progress, or budget_exhausted).
   *
   * @param initialTask The initial task instruction for the first agent.
   * @returns The result of the loop execution.
   */
  async run(initialTask: string): Promise<ControlLoopResult> {
    let iterationsRun = 0;

    // Set up initial ledger state
    this.ledgerManager.recordStep("Loop started with task: " + initialTask);

    while (true) {
      // Step 1: Check iteration limit
      if (iterationsRun >= this.config.maxIterations) {
        const ledger = this.ledgerManager.getLedger();
        return {
          exitReason: "max_iterations",
          iterationsRun,
          finalLedger: ledger,
        };
      }

      // Step 2: Increment total_actions via LoopGuard
      const guardCheck = this.loopGuard.increment("total_actions");
      if (!guardCheck.allowed) {
        const ledger = this.ledgerManager.getLedger();
        return {
          exitReason: "loop_detected",
          iterationsRun,
          finalLedger: ledger,
        };
      }

      // Step 3: Get current ledger
      const ledger = this.ledgerManager.getLedger();

      // Step 4: Check if request is satisfied
      if (ledger.is_request_satisfied) {
        return {
          exitReason: "completed",
          iterationsRun,
          finalLedger: ledger,
        };
      }

      // Step 5: Check for stall (no progress)
      const health = this.ledgerManager.checkHealth();
      if (!health.is_progress_being_made) {
        const updatedLedger = this.ledgerManager.getLedger();
        return {
          exitReason: "no_progress",
          iterationsRun,
          finalLedger: updatedLedger,
        };
      }

      // Step 6: Select next speaker
      const nextSpeaker = this.session.selectNextSpeaker(ledger, this.agents);

      // Step 7: If no speaker, exit (nothing left to do)
      if (!nextSpeaker) {
        const updatedLedger = this.ledgerManager.getLedger();
        return {
          exitReason: "completed",
          iterationsRun,
          finalLedger: updatedLedger,
        };
      }

      // Step 8: Find the agent template for this speaker
      const agent = this.agents.find((a) => a.name === nextSpeaker);
      if (!agent) {
        // If agent not found, treat as nothing left to do
        const updatedLedger = this.ledgerManager.getLedger();
        return {
          exitReason: "completed",
          iterationsRun,
          finalLedger: updatedLedger,
        };
      }

      // Step 9: Run agent with budget error handling
      try {
        await this.session.runAgent(agent, ledger.instruction || initialTask);
        this.ledgerManager.recordStep("Agent " + agent.name + " completed");
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        if (
          errorMsg.toLowerCase().includes("budget") ||
          errorMsg.includes("Budget")
        ) {
          const updatedLedger = this.ledgerManager.getLedger();
          return {
            exitReason: "budget_exhausted",
            iterationsRun,
            finalLedger: updatedLedger,
          };
        }
        // Re-throw other errors
        throw error;
      }

      // Step 10: Increment iteration counter and continue
      iterationsRun++;
    }
  }
}
