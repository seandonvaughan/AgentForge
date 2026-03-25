/**
 * Barrel export for all AgentForge type definitions.
 *
 * Import from "@/types" (or "../types") to access any type
 * without needing to know which sub-module it lives in.
 */

export type {
  ModelTier,
  EffortLevel,
  AgentCategory,
  AgentSkill,
  AgentTriggers,
  AgentCollaboration,
  AgentContext,
  AgentTemplate,
} from "./agent.js";

export type {
  TeamAgents,
  ModelRouting,
  DelegationGraph,
  TeamManifest,
} from "./team.js";

export type {
  ProjectInfo,
  RiskArea,
  CoverageGap,
  RecommendedTeam,
  ProjectAssessment,
  DocumentAnalysis,
  ResearchFindings,
  IntegrationRef,
  ProjectBrief,
} from "./analysis.js";

export type {
  MessageType,
  MessagePriority,
  MessageContext,
  AgentMessage,
} from "./message.js";

export type {
  DomainId,
  DomainPack,
  DomainScanner,
  ActivationRule,
} from "./domain.js";

export type {
  CollaborationTemplate,
  TopologyDefinition,
  DelegationRules,
  CommunicationConfig,
  GateDefinition,
  EscalationConfig,
  LoopLimits,
  CrossDomainTeam,
  DomainTeam,
  Bridge,
} from "./collaboration.js";

export type {
  ProgressLedger,
  TeamEvent,
  Handoff,
  DelegationPrimitives,
  EdgeCondition,
  DelegationEdge,
  ConditionalDelegationGraph,
} from "./orchestration.js";

export type {
  Skill,
  SkillCategory,
  SkillParameter,
} from "./skill.js";

export type {
  DomainScannerPlugin,
  ScanOutput,
} from "./scanner.js";

export type {
  FeedbackCategory,
  FeedbackPriority,
  AgentFeedback,
  FeedbackSummary,
  FeedbackTheme,
  RecommendedAction,
  FeedbackAnalysis,
} from "./feedback.js";

export type {
  TokenEstimate,
  BudgetCheckResult,
  FanOutConfig,
  FanOutResult,
  CostAwareRunDirective,
  CostAwareRunResult,
} from "./budget.js";

export type {
  ReforgeClass,
  AgentMutation,
  ReforgePlan,
  ReforgeResult,
  AgentOverride,
} from "./reforge.js";

export type {
  IntegrationTarget,
  JiraCreateIssueAction,
  GithubCreateIssueAction,
  ConfluenceCreatePageAction,
  SlackPostMessageAction,
  IntegrationAction,
  IntegrationResult,
  McpServerConfig,
  McpConfig,
} from "./integration.js";
