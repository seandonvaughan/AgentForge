import { describe, it, expect } from "vitest";
import type {
  DomainId,
  DomainPack,
  DomainScanner,
  ActivationRule,
} from "../../src/types/domain.js";
import type {
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
} from "../../src/types/collaboration.js";
import type {
  ProgressLedger,
  TeamEvent,
  Handoff,
  DelegationPrimitives,
} from "../../src/types/orchestration.js";
import type {
  Skill,
  SkillCategory,
  SkillParameter,
} from "../../src/types/skill.js";
import type {
  DomainScannerPlugin,
  ScanOutput,
} from "../../src/types/scanner.js";
import type {
  ProjectBrief,
  DocumentAnalysis,
  ResearchFindings,
  IntegrationRef,
} from "../../src/types/analysis.js";
import type { AgentTemplate } from "../../src/types/agent.js";
import type { TeamManifest, TeamAgents } from "../../src/types/team.js";

// ── Domain Types ───────────────────────────────────────────────────────

describe("v2 domain types compile correctly", () => {
  it("DomainId accepts known domain strings", () => {
    const id: DomainId = "software";
    expect(id).toBe("software");
  });

  it("DomainId accepts custom domain strings", () => {
    const id: DomainId = "custom-domain";
    expect(id).toBe("custom-domain");
  });

  it("ActivationRule accepts partial fields", () => {
    const rule: ActivationRule = { file_patterns: ["*.ts"] };
    expect(rule.file_patterns).toEqual(["*.ts"]);
    expect(rule.directories).toBeUndefined();
    expect(rule.files).toBeUndefined();
  });

  it("ActivationRule accepts all fields", () => {
    const rule: ActivationRule = {
      file_patterns: ["*.ts", "*.py"],
      directories: ["src/", "lib/"],
      files: ["package.json"],
    };
    expect(rule.file_patterns).toHaveLength(2);
    expect(rule.directories).toHaveLength(2);
    expect(rule.files).toHaveLength(1);
  });

  it("DomainScanner accepts valid data", () => {
    const scanner: DomainScanner = {
      type: "codebase",
      activates_when: [{ file_patterns: ["*.ts"] }],
      scanners: ["file-scanner"],
    };
    expect(scanner.type).toBe("codebase");
  });

  it("DomainScanner accepts all scanner types", () => {
    const types: DomainScanner["type"][] = ["codebase", "document", "hybrid"];
    expect(types).toHaveLength(3);
  });

  it("DomainPack accepts valid data", () => {
    const pack: DomainPack = {
      name: "software",
      version: "1.0",
      description: "Software domain",
      scanner: {
        type: "codebase",
        activates_when: [],
        scanners: ["file-scanner"],
      },
      agents: {
        strategic: ["architect"],
        implementation: ["coder"],
        quality: [],
        utility: [],
      },
      default_collaboration: "dev-team",
      signals: ["codebase_present"],
    };
    expect(pack.name).toBe("software");
    expect(pack.agents.strategic).toContain("architect");
    expect(pack.signals).toHaveLength(1);
  });
});

// ── Collaboration Types ────────────────────────────────────────────────

describe("v2 collaboration types compile correctly", () => {
  it("GateDefinition accepts valid data", () => {
    const gate: GateDefinition = {
      name: "code-review",
      type: "hard-gate",
      rule: "All code must be reviewed before merge",
    };
    expect(gate.type).toBe("hard-gate");
  });

  it("GateDefinition accepts soft-gate type", () => {
    const gate: GateDefinition = {
      name: "docs-check",
      type: "soft-gate",
      rule: "Documentation should be updated",
    };
    expect(gate.type).toBe("soft-gate");
  });

  it("TopologyDefinition accepts valid data", () => {
    const topology: TopologyDefinition = {
      root: "architect",
      levels: [
        { agents: ["architect"], role: "strategic" },
        { agents: ["coder", "tester"], role: "implementation" },
      ],
    };
    expect(topology.root).toBe("architect");
    expect(topology.levels).toHaveLength(2);
  });

  it("TopologyDefinition accepts null root for flat topologies", () => {
    const topology: TopologyDefinition = {
      root: null,
      levels: [{ agents: ["agent-a", "agent-b"], role: "peers" }],
    };
    expect(topology.root).toBeNull();
  });

  it("DelegationRules accepts valid data", () => {
    const rules: DelegationRules = {
      direction: "top-down",
      cross_level: false,
      peer_collaboration: true,
      review_flow: "bottom-up",
    };
    expect(rules.direction).toBe("top-down");
  });

  it("CommunicationConfig accepts valid data", () => {
    const config: CommunicationConfig = {
      patterns: ["request-response", "broadcast"],
      gates: [
        { name: "review-gate", type: "hard-gate", rule: "Must review first" },
      ],
    };
    expect(config.patterns).toHaveLength(2);
    expect(config.gates).toHaveLength(1);
  });

  it("EscalationConfig accepts valid data", () => {
    const config: EscalationConfig = {
      max_retries: 3,
      escalate_to: "architect",
      human_escalation: true,
    };
    expect(config.max_retries).toBe(3);
  });

  it("LoopLimits accepts valid data", () => {
    const limits: LoopLimits = {
      review_cycle: 3,
      delegation_depth: 5,
      retry_same_agent: 2,
      total_actions: 50,
    };
    expect(limits.review_cycle).toBe(3);
    expect(limits.total_actions).toBe(50);
  });

  it("CollaborationTemplate accepts valid data", () => {
    const template: CollaborationTemplate = {
      name: "dev-team",
      type: "hierarchy",
      description: "Standard development team hierarchy",
      topology: {
        root: "architect",
        levels: [
          { agents: ["architect"], role: "strategic" },
          { agents: ["coder"], role: "implementation" },
        ],
      },
      delegation_rules: {
        direction: "top-down",
        cross_level: false,
        peer_collaboration: true,
        review_flow: "bottom-up",
      },
      communication: {
        patterns: ["request-response"],
        gates: [],
      },
      escalation: {
        max_retries: 3,
        escalate_to: "architect",
        human_escalation: true,
      },
      loop_limits: {
        review_cycle: 3,
        delegation_depth: 5,
        retry_same_agent: 2,
        total_actions: 50,
      },
    };
    expect(template.name).toBe("dev-team");
    expect(template.type).toBe("hierarchy");
  });

  it("CollaborationTemplate accepts all topology types", () => {
    const types: CollaborationTemplate["type"][] = [
      "hierarchy",
      "flat",
      "matrix",
      "hub-and-spoke",
      "custom",
    ];
    expect(types).toHaveLength(5);
  });

  it("DomainTeam accepts valid data", () => {
    const team: DomainTeam = {
      lead: "architect",
      members: ["coder", "tester"],
      utilities: ["linter"],
      internal_topology: "hierarchy",
    };
    expect(team.lead).toBe("architect");
    expect(team.members).toHaveLength(2);
  });

  it("Bridge accepts valid data", () => {
    const bridge: Bridge = {
      from: "architect",
      to: "cmo",
      reason: "Coordinate technical and marketing requirements",
    };
    expect(bridge.from).toBe("architect");
  });

  it("Bridge accepts array of target agents", () => {
    const bridge: Bridge = {
      from: "pm",
      to: ["architect", "cmo", "coo"],
      reason: "PM coordinates all domain leads",
    };
    expect(bridge.to).toHaveLength(3);
  });

  it("CrossDomainTeam accepts valid data", () => {
    const crossTeam: CrossDomainTeam = {
      topology: "hub-and-spoke",
      coordinator: "pm",
      teams: {
        software: {
          lead: "architect",
          members: ["coder"],
          utilities: ["linter"],
          internal_topology: "hierarchy",
        },
        marketing: {
          lead: "cmo",
          members: ["content-writer"],
          utilities: [],
          internal_topology: "flat",
        },
      },
      bridges: [
        {
          from: "pm",
          to: ["architect", "cmo"],
          reason: "Central coordination",
        },
      ],
      shared_utilities: ["researcher", "file-reader"],
    };
    expect(crossTeam.coordinator).toBe("pm");
    expect(Object.keys(crossTeam.teams)).toHaveLength(2);
  });
});

// ── Orchestration Types ────────────────────────────────────────────────

describe("v2 orchestration types compile correctly", () => {
  it("ProgressLedger accepts valid data", () => {
    const ledger: ProgressLedger = {
      task_id: "task-001",
      objective: "Build authentication system",
      facts: {
        given: ["Using TypeScript", "Express backend"],
        to_look_up: ["OAuth2 best practices"],
        to_derive: ["Session management approach"],
        educated_guesses: ["JWT likely suitable"],
      },
      plan: ["Design API", "Implement routes", "Add tests"],
      steps_completed: ["Design API"],
      current_step: "Implement routes",
      is_request_satisfied: false,
      is_in_loop: false,
      is_progress_being_made: true,
      confidence: 0.8,
      next_speaker: "coder",
      instruction: "Implement the auth routes as designed",
    };
    expect(ledger.task_id).toBe("task-001");
    expect(ledger.facts.given).toHaveLength(2);
    expect(ledger.confidence).toBe(0.8);
  });

  it("ProgressLedger accepts null current_step and next_speaker", () => {
    const ledger: ProgressLedger = {
      task_id: "task-002",
      objective: "Research competitors",
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
      is_progress_being_made: false,
      confidence: 0,
      next_speaker: null,
      instruction: "",
    };
    expect(ledger.current_step).toBeNull();
    expect(ledger.next_speaker).toBeNull();
  });

  it("TeamEvent accepts valid data", () => {
    const event: TeamEvent = {
      type: "security_alert",
      source: "security-auditor",
      payload: { severity: "high", cve: "CVE-2024-1234" },
      notify: ["coder", "devops-engineer", "architect"],
    };
    expect(event.type).toBe("security_alert");
    expect(event.notify).toHaveLength(3);
  });

  it("Handoff accepts valid data", () => {
    const handoff: Handoff = {
      from: "architect",
      to: "coder",
      artifact: {
        type: "plan",
        summary: "Authentication system design with JWT and refresh tokens",
        location: "docs/auth-design.md",
        confidence: 0.95,
      },
      open_questions: ["Should we support OAuth2 social logins?"],
      constraints: ["Must use existing user table schema"],
      status: "complete",
    };
    expect(handoff.artifact.type).toBe("plan");
    expect(handoff.artifact.confidence).toBe(0.95);
    expect(handoff.status).toBe("complete");
  });

  it("Handoff accepts all artifact types", () => {
    const types: Handoff["artifact"]["type"][] = [
      "code",
      "document",
      "analysis",
      "plan",
      "review",
      "data",
    ];
    expect(types).toHaveLength(6);
  });

  it("Handoff accepts all status values", () => {
    const statuses: Handoff["status"][] = [
      "complete",
      "partial",
      "needs_review",
    ];
    expect(statuses).toHaveLength(3);
  });

  it("DelegationPrimitives accepts valid data", () => {
    const primitives: DelegationPrimitives = {
      delegate_work: {
        task: "Write unit tests for auth module",
        context: "Auth module uses JWT, see docs/auth-design.md",
        coworker: "test-engineer",
        response_format: "structured",
      },
      ask_coworker: {
        question: "What is the recommended session timeout?",
        context: "Building auth system with JWT tokens",
        coworker: "security-auditor",
      },
    };
    expect(primitives.delegate_work.coworker).toBe("test-engineer");
    expect(primitives.ask_coworker.coworker).toBe("security-auditor");
  });
});

// ── Skill Types ────────────────────────────────────────────────────────

describe("v2 skill types compile correctly", () => {
  it("SkillParameter accepts valid data", () => {
    const param: SkillParameter = {
      name: "file_path",
      type: "string",
      required: true,
    };
    expect(param.name).toBe("file_path");
    expect(param.required).toBe(true);
  });

  it("SkillParameter accepts optional default value", () => {
    const param: SkillParameter = {
      name: "max_depth",
      type: "number",
      required: false,
      default: 3,
    };
    expect(param.default).toBe(3);
  });

  it("SkillCategory accepts all valid values", () => {
    const categories: SkillCategory[] = [
      "research",
      "analysis",
      "creation",
      "review",
      "planning",
      "communication",
    ];
    expect(categories).toHaveLength(6);
  });

  it("Skill accepts valid data", () => {
    const skill: Skill = {
      name: "code_review",
      version: "1.0",
      category: "review",
      domain: "software",
      model_preference: "sonnet",
      description: "Reviews code for quality, security, and best practices",
      parameters: [
        { name: "file_path", type: "string", required: true },
        { name: "focus_areas", type: "string[]", required: false, default: [] },
      ],
      gates: {
        pre: ["file_exists"],
        post: ["review_complete"],
      },
      composable_with: ["security_audit", "test_generate"],
    };
    expect(skill.name).toBe("code_review");
    expect(skill.category).toBe("review");
    expect(skill.parameters).toHaveLength(2);
    expect(skill.gates.pre).toHaveLength(1);
    expect(skill.composable_with).toHaveLength(2);
  });
});

// ── Scanner Types ──────────────────────────────────────────────────────

describe("v2 scanner types compile correctly", () => {
  it("ScanOutput accepts valid data", () => {
    const output: ScanOutput = {
      scanner: "file-scanner",
      domain: "software",
      signals: ["codebase_present", "programming_languages_detected"],
      data: {
        languages: { TypeScript: 80, Python: 20 },
        frameworks: ["Next.js"],
      },
    };
    expect(output.scanner).toBe("file-scanner");
    expect(output.signals).toHaveLength(2);
  });

  it("DomainScannerPlugin accepts valid data", () => {
    const plugin: DomainScannerPlugin = {
      name: "file-scanner",
      domain: "software",
      model: "haiku",
      scan: async (_projectRoot: string) => ({
        scanner: "file-scanner",
        domain: "software",
        signals: ["codebase_present"],
        data: { files: 100 },
      }),
    };
    expect(plugin.name).toBe("file-scanner");
    expect(plugin.model).toBe("haiku");
  });
});

// ── Updated Analysis Types ─────────────────────────────────────────────

describe("v2 analysis types compile correctly", () => {
  it("DocumentAnalysis accepts valid data", () => {
    const doc: DocumentAnalysis = {
      type: "business-plan",
      path: "docs/business-plan.md",
      summary: "A comprehensive business plan for an AI analytics SaaS",
    };
    expect(doc.type).toBe("business-plan");
  });

  it("ResearchFindings accepts valid data with known fields", () => {
    const research: ResearchFindings = {
      market_size: "$50B TAM",
      competitors: ["Competitor A", "Competitor B"],
      industry_trends: ["AI-first analytics", "Self-serve BI"],
    };
    expect(research.market_size).toBe("$50B TAM");
    expect(research.competitors).toHaveLength(2);
  });

  it("ResearchFindings accepts additional unknown fields", () => {
    const research: ResearchFindings = {
      market_size: "$50B TAM",
      custom_field: "custom value",
    };
    expect(research.custom_field).toBe("custom value");
  });

  it("IntegrationRef accepts valid data", () => {
    const ref: IntegrationRef = {
      type: "jira",
      ref: "PROJECT-KEY",
    };
    expect(ref.type).toBe("jira");
  });

  it("ProjectBrief accepts valid data", () => {
    const brief: ProjectBrief = {
      project: {
        name: "Project X",
        type: "saas-product",
        stage: "early",
      },
      goals: {
        primary: "Build an AI-powered analytics platform",
        secondary: ["Raise Series A", "Launch beta by Q3"],
      },
      domains: ["software", "business", "marketing"],
      constraints: {
        budget: "bootstrapped",
        timeline: "6 months",
        team_size: "solo founder",
      },
      context: {
        codebase: {
          name: "analytics-platform",
          primary_language: "TypeScript",
          languages: ["TypeScript", "Python"],
          frameworks: ["Next.js", "FastAPI"],
          architecture: "monorepo",
          size: { files: 342, loc: 48000 },
        },
        documents: [
          {
            type: "business-plan",
            path: "docs/business-plan.md",
            summary: "AI analytics SaaS business plan",
          },
        ],
        research: {
          market_size: "$50B TAM",
          competitors: ["Tableau", "Looker"],
          industry_trends: ["AI-first analytics"],
        },
        integrations: [
          { type: "jira", ref: "PROJ-KEY" },
          { type: "confluence", ref: "space-id" },
        ],
      },
    };
    expect(brief.project.name).toBe("Project X");
    expect(brief.project.stage).toBe("early");
    expect(brief.domains).toHaveLength(3);
    expect(brief.context.codebase?.name).toBe("analytics-platform");
    expect(brief.context.documents).toHaveLength(1);
    expect(brief.context.integrations).toHaveLength(2);
  });

  it("ProjectBrief accepts minimal context", () => {
    const brief: ProjectBrief = {
      project: {
        name: "New Venture",
        type: "startup",
        stage: "early",
      },
      goals: {
        primary: "Explore new market opportunity",
        secondary: [],
      },
      domains: ["business"],
      constraints: {},
      context: {},
    };
    expect(brief.context.codebase).toBeUndefined();
    expect(brief.context.documents).toBeUndefined();
  });

  it("ProjectBrief accepts all stage values", () => {
    const stages: ProjectBrief["project"]["stage"][] = [
      "early",
      "growth",
      "mature",
      "pivot",
    ];
    expect(stages).toHaveLength(4);
  });
});

// ── Updated Agent Types ────────────────────────────────────────────────

describe("v2 agent type extensions compile correctly", () => {
  it("AgentTemplate still works without new optional fields", () => {
    const agent: AgentTemplate = {
      name: "coder",
      model: "sonnet",
      version: "1.0",
      description: "Code implementation agent",
      system_prompt: "You are a coder.",
      skills: ["code_write"],
      triggers: { file_patterns: ["*.ts"], keywords: ["implement"] },
      collaboration: {
        reports_to: "architect",
        reviews_from: ["test-engineer"],
        can_delegate_to: [],
        parallel: true,
      },
      context: { max_files: 20, auto_include: [], project_specific: [] },
    };
    expect(agent.name).toBe("coder");
    expect(agent.domain).toBeUndefined();
    expect(agent.iron_laws).toBeUndefined();
    expect(agent.gates).toBeUndefined();
    expect(agent.subscriptions).toBeUndefined();
  });

  it("AgentTemplate accepts new optional domain field", () => {
    const agent: AgentTemplate = {
      name: "coder",
      model: "sonnet",
      version: "1.0",
      description: "Code implementation agent",
      system_prompt: "You are a coder.",
      skills: ["code_write"],
      triggers: { file_patterns: [], keywords: [] },
      collaboration: {
        reports_to: null,
        reviews_from: [],
        can_delegate_to: [],
        parallel: false,
      },
      context: { max_files: 10, auto_include: [], project_specific: [] },
      domain: "software",
    };
    expect(agent.domain).toBe("software");
  });

  it("AgentTemplate accepts new optional iron_laws field", () => {
    const agent: AgentTemplate = {
      name: "security-auditor",
      model: "sonnet",
      version: "1.0",
      description: "Security auditor",
      system_prompt: "You are a security auditor.",
      skills: ["security_audit"],
      triggers: { file_patterns: [], keywords: [] },
      collaboration: {
        reports_to: null,
        reviews_from: [],
        can_delegate_to: [],
        parallel: false,
      },
      context: { max_files: 10, auto_include: [], project_specific: [] },
      iron_laws: [
        "NEVER skip security checks",
        "ALWAYS report vulnerabilities",
      ],
    };
    expect(agent.iron_laws).toHaveLength(2);
  });

  it("AgentTemplate accepts new optional gates field", () => {
    const agent: AgentTemplate = {
      name: "coder",
      model: "sonnet",
      version: "1.0",
      description: "Coder",
      system_prompt: "You are a coder.",
      skills: [],
      triggers: { file_patterns: [], keywords: [] },
      collaboration: {
        reports_to: null,
        reviews_from: [],
        can_delegate_to: [],
        parallel: false,
      },
      context: { max_files: 10, auto_include: [], project_specific: [] },
      gates: {
        pre: ["design_approved"],
        post: ["tests_pass", "review_complete"],
      },
    };
    expect(agent.gates?.pre).toHaveLength(1);
    expect(agent.gates?.post).toHaveLength(2);
  });

  it("AgentTemplate accepts new optional subscriptions field", () => {
    const agent: AgentTemplate = {
      name: "coder",
      model: "sonnet",
      version: "1.0",
      description: "Coder",
      system_prompt: "You are a coder.",
      skills: [],
      triggers: { file_patterns: [], keywords: [] },
      collaboration: {
        reports_to: null,
        reviews_from: [],
        can_delegate_to: [],
        parallel: false,
      },
      context: { max_files: 10, auto_include: [], project_specific: [] },
      subscriptions: [
        "architecture_decision",
        "security_alert",
        "dependency_change",
      ],
    };
    expect(agent.subscriptions).toHaveLength(3);
  });

  it("AgentTemplate accepts all new optional fields at once", () => {
    const agent: AgentTemplate = {
      name: "coder",
      model: "sonnet",
      version: "1.0",
      description: "Coder",
      system_prompt: "You are a coder.",
      skills: [],
      triggers: { file_patterns: [], keywords: [] },
      collaboration: {
        reports_to: null,
        reviews_from: [],
        can_delegate_to: [],
        parallel: false,
      },
      context: { max_files: 10, auto_include: [], project_specific: [] },
      domain: "software",
      iron_laws: ["NEVER deploy without tests"],
      gates: { pre: [], post: ["tests_pass"] },
      subscriptions: ["architecture_decision"],
    };
    expect(agent.domain).toBe("software");
    expect(agent.iron_laws).toHaveLength(1);
    expect(agent.gates?.post).toHaveLength(1);
    expect(agent.subscriptions).toHaveLength(1);
  });
});

// ── Updated Team Types ─────────────────────────────────────────────────

describe("v2 team type extensions compile correctly", () => {
  it("TeamAgents still works with standard categories", () => {
    const agents: TeamAgents = {
      strategic: ["architect"],
      implementation: ["coder"],
      quality: ["tester"],
      utility: ["linter"],
    };
    expect(agents.strategic).toHaveLength(1);
  });

  it("TeamAgents accepts custom categories via index signature", () => {
    const agents: TeamAgents = {
      strategic: ["architect"],
      implementation: ["coder"],
      quality: [],
      utility: [],
      leadership: ["ceo", "cto"],
    };
    expect(agents["leadership"]).toHaveLength(2);
  });

  it("TeamManifest still works without new optional fields", () => {
    const manifest: TeamManifest = {
      name: "test-team",
      forged_at: "2026-03-25T00:00:00Z",
      forged_by: "test-user",
      project_hash: "abc123",
      agents: {
        strategic: ["architect"],
        implementation: ["coder"],
        quality: [],
        utility: [],
      },
      model_routing: { opus: [], sonnet: ["architect", "coder"], haiku: [] },
      delegation_graph: { architect: ["coder"] },
    };
    expect(manifest.name).toBe("test-team");
    expect(manifest.project_brief).toBeUndefined();
    expect(manifest.domains).toBeUndefined();
    expect(manifest.collaboration).toBeUndefined();
  });

  it("TeamManifest accepts new optional fields", () => {
    const manifest: TeamManifest = {
      name: "multi-domain-team",
      forged_at: "2026-03-25T00:00:00Z",
      forged_by: "genesis",
      project_hash: "def456",
      agents: {
        strategic: ["architect", "cmo"],
        implementation: ["coder", "content-writer"],
        quality: ["tester"],
        utility: ["researcher"],
      },
      model_routing: {
        opus: ["architect"],
        sonnet: ["cmo", "coder", "content-writer", "tester"],
        haiku: ["researcher"],
      },
      delegation_graph: { architect: ["coder"], cmo: ["content-writer"] },
      project_brief: {
        project: { name: "My SaaS", type: "saas", stage: "early" },
        goals: { primary: "Build SaaS product", secondary: [] },
        domains: ["software", "marketing"],
        constraints: {},
        context: {},
      },
      domains: ["software", "marketing"],
      collaboration: {
        name: "hub-and-spoke",
        type: "hub-and-spoke",
        description: "Multi-domain team with central coordinator",
        topology: {
          root: "pm",
          levels: [
            { agents: ["pm"], role: "coordinator" },
            { agents: ["architect", "cmo"], role: "domain-leads" },
          ],
        },
        delegation_rules: {
          direction: "top-down",
          cross_level: true,
          peer_collaboration: true,
          review_flow: "bottom-up",
        },
        communication: { patterns: ["broadcast"], gates: [] },
        escalation: {
          max_retries: 3,
          escalate_to: "pm",
          human_escalation: true,
        },
        loop_limits: {
          review_cycle: 3,
          delegation_depth: 5,
          retry_same_agent: 2,
          total_actions: 50,
        },
      },
    };
    expect(manifest.project_brief?.project.name).toBe("My SaaS");
    expect(manifest.domains).toHaveLength(2);
    expect(manifest.collaboration?.type).toBe("hub-and-spoke");
  });
});

// ── Barrel Export Verification ──────────────────────────────────────────

describe("barrel exports include all v2 types", () => {
  it("all new types can be imported from barrel export", async () => {
    // Dynamic import to verify barrel exports compile
    const types = await import("../../src/types/index.js");
    // The barrel export only re-exports types, so we just verify it loads
    expect(types).toBeDefined();
  });
});
