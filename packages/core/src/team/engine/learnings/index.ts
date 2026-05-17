/**
 * Learning curator barrel export — T2.1 continuous-improvement pipeline.
 *
 * Consumers should import from this module rather than from the individual
 * sub-modules directly so that refactoring sub-module filenames stays local.
 */

export type { MemoryEntry } from "./memory-reader.js";
export { readMemoryEntries } from "./memory-reader.js";

export type { ScoredEntry } from "./scorer.js";
export { scoreEntry, recencyScore, parseSeverity, hasRoleMatch } from "./scorer.js";

export { extractLesson, curateLearnings } from "./curator.js";

export type {
  ProposedLearning,
  CurationInput,
  CurationResult,
} from "./types.js";
