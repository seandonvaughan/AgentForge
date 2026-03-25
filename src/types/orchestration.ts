/**
 * Orchestration type definitions for the AgentForge v2 Universal Forge.
 *
 * Covers runtime state tracking (progress ledger), inter-agent events,
 * structured handoffs, and delegation primitives.
 */

/**
 * A structured state tracker that monitors team execution.
 *
 * The orchestrator evaluates the ledger after every agent action to
 * detect stalls, loops, and completion. Inspired by AutoGen Magentic-One.
 */
export interface ProgressLedger {
  /** Unique identifier for the task being tracked. */
  task_id: string;
  /** The high-level objective this task aims to achieve. */
  objective: string;

  /** Categorized fact tracking for the current task. */
  facts: {
    /** Known facts provided by the task or context. */
    given: string[];
    /** Facts that need external research. */
    to_look_up: string[];
    /** Facts that need computation or reasoning. */
    to_derive: string[];
    /** Uncertain but useful assumptions. */
    educated_guesses: string[];
  };

  /** Current step-by-step execution plan. */
  plan: string[];
  /** Steps that have been completed. */
  steps_completed: string[];
  /** The step currently in progress, or null if idle. */
  current_step: string | null;

  /** Whether the objective has been met. */
  is_request_satisfied: boolean;
  /** Whether the same actions are being repeated. */
  is_in_loop: boolean;
  /** Whether forward progress is occurring. */
  is_progress_being_made: boolean;
  /** Confidence in the current approach (0-1). */
  confidence: number;

  /** Which agent should act next, or null if undecided. */
  next_speaker: string | null;
  /** Instruction to give the next speaker. */
  instruction: string;
}

/**
 * A broadcast event that notifies multiple agents of a change.
 *
 * Used for cross-cutting concerns such as security alerts,
 * architecture decisions, or dependency changes.
 */
export interface TeamEvent {
  /** Event type identifier (e.g. "security_alert", "architecture_decision"). */
  type: string;
  /** Name of the agent that triggered this event. */
  source: string;
  /** Event-specific data. */
  payload: unknown;
  /** Agent names to notify, or ["*"] for all agents. */
  notify: string[];
}

/**
 * Structured metadata for a work handoff between agents.
 *
 * Prevents context loss in pipeline patterns by carrying artifact
 * details, open questions, and constraints forward.
 */
export interface Handoff {
  /** Agent handing off the work. */
  from: string;
  /** Agent receiving the work. */
  to: string;
  /** Description of the artifact being handed off. */
  artifact: {
    /** What kind of artifact was produced. */
    type: "code" | "document" | "analysis" | "plan" | "review" | "data";
    /** Human-readable summary of the artifact. */
    summary: string;
    /** Where the artifact lives (file path, URL, etc.). */
    location: string;
    /** How confident the producing agent is in this artifact (0-1). */
    confidence: number;
  };
  /** Questions the receiving agent should address. */
  open_questions: string[];
  /** Decisions already made that must be respected. */
  constraints: string[];
  /** Completion status of the work being handed off. */
  status: "complete" | "partial" | "needs_review";
}

/**
 * Two battle-tested delegation primitives injected into every
 * agent that has `can_delegate_to` configured.
 *
 * `delegate_work` hands off responsibility — the delegate owns the outcome.
 * `ask_coworker` requests information — the asker retains ownership.
 * Inspired by CrewAI.
 */
export interface DelegationPrimitives {
  /** Delegate a complete task to a coworker. */
  delegate_work: {
    /** What needs to be done. */
    task: string;
    /** Relevant background and constraints. */
    context: string;
    /** Target agent name. */
    coworker: string;
    /** How the response should be formatted. */
    response_format: "summary" | "full" | "structured";
  };
  /** Ask a coworker a question without delegating the full task. */
  ask_coworker: {
    /** What you need to know. */
    question: string;
    /** Why you need it. */
    context: string;
    /** Target agent name. */
    coworker: string;
  };
}

/** Condition for a conditional delegation edge. */
export interface EdgeCondition {
  type: "ledger-state" | "confidence" | "cost-budget" | "feedback-theme";
  field: string;
  operator: "equals" | "not-equals" | "greater-than" | "less-than" | "contains";
  value: unknown;
}

/** A delegation edge that may be conditional on runtime state. */
export interface DelegationEdge {
  from: string;
  to: string;
  condition?: EdgeCondition;
}

/** Delegation graph where edges can have runtime conditions. */
export type ConditionalDelegationGraph = Record<string, DelegationEdge[]>;
