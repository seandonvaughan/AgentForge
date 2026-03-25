/**
 * Interview system for the AgentForge Genesis workflow.
 *
 * Defines the interview question flow that collects project context
 * when scanner signals are insufficient to fully characterize the project.
 *
 * The question set adapts to the discovery state so that:
 * - Empty projects receive a comprehensive onboarding interview.
 * - Codebase-only projects receive targeted gap-filling questions.
 * - Document-only projects receive research and goal questions.
 * - Full projects receive minimal confirmation questions.
 *
 * NOTE: Full API-driven interview wiring will be completed in Phase H.
 * This module provides the question definitions and selection logic.
 */

import type { DiscoveryState } from "./discovery.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single structured interview question. */
export interface InterviewQuestion {
  /** Stable identifier used to key the collected answer. */
  id: string;
  /** The human-readable question text. */
  question: string;
  /** How this question should be rendered / collected. */
  type: "text" | "choice" | "confirm";
  /** Available choices when `type === "choice"`. */
  choices?: string[];
  /**
   * Optional predicate evaluated against answers collected so far.
   * When defined, the question is only asked if the predicate returns true.
   */
  condition?: (answers: Record<string, string>) => boolean;
}

// ---------------------------------------------------------------------------
// Question banks
// ---------------------------------------------------------------------------

/**
 * Core questions asked for every project regardless of discovery state.
 */
const CORE_QUESTIONS: InterviewQuestion[] = [
  {
    id: "project_name",
    question: "What is the name of this project?",
    type: "text",
  },
  {
    id: "primary_goal",
    question: "What is the primary goal you want to achieve with this project?",
    type: "text",
  },
];

/**
 * Questions asked when no context was discovered (empty directory).
 * These establish the full picture from scratch.
 */
const EMPTY_QUESTIONS: InterviewQuestion[] = [
  {
    id: "project_type",
    question: "What type of project is this?",
    type: "choice",
    choices: [
      "Software product / application",
      "Business / startup",
      "Research project",
      "Marketing campaign",
      "Internal tool",
      "Other",
    ],
  },
  {
    id: "domain",
    question:
      "Which domain best describes this project?",
    type: "choice",
    choices: [
      "Software development",
      "Business strategy",
      "Marketing",
      "Product management",
      "Research",
      "Sales",
      "Legal",
      "HR",
      "IT / Infrastructure",
    ],
  },
  {
    id: "secondary_goals",
    question:
      "List any secondary goals (comma-separated), or leave blank to skip.",
    type: "text",
  },
  {
    id: "target_audience",
    question: "Who is the target audience or end user for this project?",
    type: "text",
  },
  {
    id: "timeline",
    question:
      "What is your target timeline or deadline (e.g. '3 months', 'end of Q3')?",
    type: "text",
  },
  {
    id: "budget",
    question: "What budget tier applies?",
    type: "choice",
    choices: ["bootstrapped", "seed-funded", "series-a+", "enterprise", "unknown"],
  },
  {
    id: "team_size",
    question: "How large is the team working on this project?",
    type: "choice",
    choices: ["solo", "2-5", "6-15", "16-50", "50+"],
  },
];

/**
 * Questions asked when only a codebase is discovered.
 * The scanners provide technical context so these focus on strategic gaps.
 */
const CODEBASE_QUESTIONS: InterviewQuestion[] = [
  {
    id: "secondary_goals",
    question:
      "What are the secondary goals for this project (comma-separated)?",
    type: "text",
  },
  {
    id: "deployment",
    question: "Where is this project deployed or expected to run?",
    type: "choice",
    choices: ["cloud (AWS/GCP/Azure)", "on-premises", "edge/embedded", "not yet decided"],
  },
  {
    id: "compliance",
    question:
      "Are there any compliance or regulatory requirements (e.g. GDPR, HIPAA)?",
    type: "text",
  },
];

/**
 * Questions asked when only documents are discovered.
 * These supplement the document analysis with strategic context.
 */
const DOCUMENTS_QUESTIONS: InterviewQuestion[] = [
  {
    id: "secondary_goals",
    question:
      "What are the secondary goals for this project (comma-separated)?",
    type: "text",
  },
  {
    id: "domain",
    question: "Which domain best describes this project?",
    type: "choice",
    choices: [
      "Business strategy",
      "Marketing",
      "Product management",
      "Research",
      "Sales",
      "Legal",
      "HR",
      "Other",
    ],
  },
  {
    id: "timeline",
    question:
      "What is the target timeline or deadline for this project?",
    type: "text",
  },
  {
    id: "budget",
    question: "What budget tier applies?",
    type: "choice",
    choices: ["bootstrapped", "seed-funded", "series-a+", "enterprise", "unknown"],
  },
];

/**
 * Questions asked when both a codebase and documents are discovered.
 * Rich context already exists so only confirmation / gap questions are asked.
 */
const FULL_QUESTIONS: InterviewQuestion[] = [
  {
    id: "confirm_goals",
    question:
      "I found both source code and documentation for this project. " +
      "Is there anything you'd like to emphasize or correct about the project goals?",
    type: "text",
  },
  {
    id: "compliance",
    question:
      "Are there compliance or regulatory requirements I should be aware of?",
    type: "text",
  },
];

/**
 * Questions asked when the user selects "Research project" as their project type.
 * These capture research-specific context about methodology, deliverables, and data sensitivity.
 */
const RESEARCH_QUESTIONS: InterviewQuestion[] = [
  {
    id: "research_modality",
    question: "What best describes your research process?",
    type: "choice",
    choices: [
      "Literature review and synthesis",
      "Experiment design and data collection",
      "Data analysis and modeling",
      "Machine learning / model training",
      "Mixed methods",
    ],
  },
  {
    id: "output_artifact",
    question: "What is the primary deliverable of this research?",
    type: "choice",
    choices: [
      "Academic paper or report",
      "Dataset or benchmark",
      "Trained model or prototype",
      "Internal analysis memo",
      "Dashboard or visualization",
    ],
  },
  {
    id: "data_sensitivity",
    question:
      "Does this research involve sensitive or proprietary data? If yes, briefly describe the constraint. (Press enter to skip)",
    type: "text",
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the list of interview questions appropriate for the given discovery state.
 *
 * All states receive the core questions (project name, primary goal) followed
 * by state-specific questions that fill in what the scanner could not determine.
 *
 * If answers include a project_type of "research", RESEARCH_QUESTIONS are appended
 * to gather research-specific context.
 *
 * @param discoveryState - The project state returned by {@link discover}.
 * @param answers - Optional object of collected answers so far; used to determine if research questions should be included.
 * @returns Ordered array of {@link InterviewQuestion} objects to ask.
 */
export function getInterviewQuestions(
  discoveryState: DiscoveryState | string,
  answers?: Record<string, string>,
): InterviewQuestion[] {
  let stateQuestions: InterviewQuestion[];

  switch (discoveryState) {
    case "empty":
      stateQuestions = EMPTY_QUESTIONS;
      break;
    case "codebase":
      stateQuestions = CODEBASE_QUESTIONS;
      break;
    case "documents":
      stateQuestions = DOCUMENTS_QUESTIONS;
      break;
    case "full":
      stateQuestions = FULL_QUESTIONS;
      break;
    default:
      // Unknown state — fall back to the comprehensive empty-project interview
      stateQuestions = EMPTY_QUESTIONS;
  }

  const allQuestions = [...CORE_QUESTIONS, ...stateQuestions];

  // Conditionally append research questions if the project type is research
  if (answers?.project_type) {
    const projectType = answers.project_type.toLowerCase();
    if (projectType.includes("research")) {
      allQuestions.push(...RESEARCH_QUESTIONS);
    }
  }

  return allQuestions;
}
