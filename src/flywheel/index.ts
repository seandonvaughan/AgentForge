// Barrel exports — flywheel module

export {
  MetaLearningEngine,
  InMemoryTierPersistence,
  type TaskOutcome,
  type SessionOutcome,
  type PromotionEvent,
  type TierPersistence,
  type PatternStat,
  type Insight,
  type KnowledgeGraphEdge,
  type KnowledgeGraph,
} from "./meta-learning-engine.js";

export {
  CapabilityInheritance,
  type AgentSkill,
  type PropagationResult,
} from "./capability-inheritance.js";

export {
  AutonomyGovernor,
  type AgentAutonomyRecord,
  type TierChangeResult,
} from "./autonomy-governor.js";

export {
  FlywheelMonitor,
  type SprintVelocity,
  type FlywheelComponent,
  type FlywheelHealth,
} from "./flywheel-monitor.js";

export {
  MentorshipFramework,
  type MentorshipPairing,
  type MentorshipReview,
  type MenteeProgress,
} from "./mentorship-framework.js";
