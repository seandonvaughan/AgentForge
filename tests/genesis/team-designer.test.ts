import { describe, it, expect } from "vitest";
import { designTeam } from "../../src/genesis/team-designer.js";
import type { ProjectBrief } from "../../src/types/analysis.js";
import type { DomainPack, DomainId } from "../../src/types/domain.js";
import type { AgentTemplate } from "../../src/types/agent.js";

// ---------------------------------------------------------------------------
// Helpers — build mock data
// ---------------------------------------------------------------------------

function makeProjectBrief(overrides: Partial<ProjectBrief> = {}): ProjectBrief {
  return {
    project: {
      name: "Test Project",
      type: "software",
      stage: "early",
      ...overrides.project,
    },
    goals: {
      primary: "Build a REST API",
      secondary: [],
      ...overrides.goals,
    },
    domains: ["core", "software"],
    constraints: {},
    context: {},
    ...overrides,
  };
}

function makeDomainPack(
  overrides: Partial<DomainPack> & { name: DomainId },
): DomainPack {
  return {
    version: "1.0",
    description: "",
    scanner: {
      type: "codebase",
      activates_when: [],
      scanners: [],
    },
    agents: {
      strategic: [],
      implementation: [],
      quality: [],
      utility: [],
    },
    default_collaboration: "flat",
    signals: [],
    ...overrides,
  };
}

function makeAgentTemplate(name: string, model: "opus" | "sonnet" | "haiku" = "sonnet"): AgentTemplate {
  return {
    name,
    model,
    version: "1.0",
    description: `${name} agent`,
    system_prompt: `You are the ${name}.`,
    skills: [],
    triggers: { file_patterns: [], keywords: [] },
    collaboration: {
      reports_to: null,
      reviews_from: [],
      can_delegate_to: [],
      parallel: false,
    },
    context: {
      max_files: 20,
      auto_include: [],
      project_specific: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("designTeam", () => {
  describe("basic team assembly", () => {
    it("returns a TeamManifest with expected shape", () => {
      const brief = makeProjectBrief();
      const softwarePack = makeDomainPack({
        name: "software",
        agents: {
          strategic: ["architect"],
          implementation: ["coder"],
          quality: ["test-engineer"],
          utility: ["file-reader"],
        },
      });
      const domainPacks = new Map<DomainId, DomainPack>([
        ["software", softwarePack],
      ]);
      const templates = new Map<DomainId, Map<string, AgentTemplate>>();

      const manifest = designTeam(brief, ["software"], domainPacks, templates);

      expect(manifest).toHaveProperty("name");
      expect(manifest).toHaveProperty("forged_at");
      expect(manifest).toHaveProperty("forged_by");
      expect(manifest).toHaveProperty("agents");
      expect(manifest).toHaveProperty("model_routing");
      expect(manifest).toHaveProperty("delegation_graph");
      expect(manifest).toHaveProperty("project_brief");
      expect(manifest).toHaveProperty("domains");
    });

    it("populates agents from the active domain pack", () => {
      const brief = makeProjectBrief();
      const softwarePack = makeDomainPack({
        name: "software",
        agents: {
          strategic: ["architect"],
          implementation: ["coder"],
          quality: [],
          utility: ["file-reader"],
        },
      });
      const domainPacks = new Map<DomainId, DomainPack>([
        ["software", softwarePack],
      ]);
      const templates = new Map<DomainId, Map<string, AgentTemplate>>();

      const manifest = designTeam(brief, ["software"], domainPacks, templates);

      expect(manifest.agents.strategic).toContain("architect");
      expect(manifest.agents.implementation).toContain("coder");
      expect(manifest.agents.utility).toContain("file-reader");
    });

    it("attaches the project brief to the manifest", () => {
      const brief = makeProjectBrief({ project: { name: "My App", type: "software", stage: "early" } });
      const domainPacks = new Map<DomainId, DomainPack>();
      const templates = new Map<DomainId, Map<string, AgentTemplate>>();

      const manifest = designTeam(brief, [], domainPacks, templates);

      expect(manifest.project_brief).toBeDefined();
      expect(manifest.project_brief!.project.name).toBe("My App");
    });

    it("records the active domains on the manifest", () => {
      const brief = makeProjectBrief();
      const domainPacks = new Map<DomainId, DomainPack>();
      const templates = new Map<DomainId, Map<string, AgentTemplate>>();

      const manifest = designTeam(brief, ["core", "software"], domainPacks, templates);

      expect(manifest.domains).toContain("core");
      expect(manifest.domains).toContain("software");
    });

    it("forged_by is set to 'genesis'", () => {
      const brief = makeProjectBrief();
      const manifest = designTeam(brief, [], new Map(), new Map());
      expect(manifest.forged_by).toBe("genesis");
    });

    it("forged_at is a valid ISO-8601 timestamp", () => {
      const brief = makeProjectBrief();
      const manifest = designTeam(brief, [], new Map(), new Map());
      expect(() => new Date(manifest.forged_at).toISOString()).not.toThrow();
    });
  });

  describe("model assignment", () => {
    it("assigns 'opus' to architect (strategic agent name pattern)", () => {
      const brief = makeProjectBrief();
      const pack = makeDomainPack({
        name: "software",
        agents: { strategic: ["architect"], implementation: [], quality: [], utility: [] },
      });
      const domainPacks = new Map<DomainId, DomainPack>([["software", pack]]);

      const manifest = designTeam(brief, ["software"], domainPacks, new Map());

      expect(manifest.model_routing.opus).toContain("architect");
    });

    it("assigns 'haiku' to file-reader (utility agent name pattern)", () => {
      const brief = makeProjectBrief();
      const pack = makeDomainPack({
        name: "software",
        agents: { strategic: [], implementation: [], quality: [], utility: ["file-reader"] },
      });
      const domainPacks = new Map<DomainId, DomainPack>([["software", pack]]);

      const manifest = designTeam(brief, ["software"], domainPacks, new Map());

      expect(manifest.model_routing.haiku).toContain("file-reader");
    });

    it("assigns 'sonnet' to coder by default", () => {
      const brief = makeProjectBrief();
      const pack = makeDomainPack({
        name: "software",
        agents: { strategic: [], implementation: ["coder"], quality: [], utility: [] },
      });
      const domainPacks = new Map<DomainId, DomainPack>([["software", pack]]);

      const manifest = designTeam(brief, ["software"], domainPacks, new Map());

      expect(manifest.model_routing.sonnet).toContain("coder");
    });

    it("respects model tier from agent template when available", () => {
      const brief = makeProjectBrief();
      const pack = makeDomainPack({
        name: "software",
        agents: { strategic: [], implementation: ["coder"], quality: [], utility: [] },
      });
      const domainPacks = new Map<DomainId, DomainPack>([["software", pack]]);

      // Template overrides model to "haiku"
      const templateMap = new Map<string, AgentTemplate>([
        ["coder", makeAgentTemplate("coder", "haiku")],
      ]);
      const templates = new Map<DomainId, Map<string, AgentTemplate>>([
        ["software", templateMap],
      ]);

      const manifest = designTeam(brief, ["software"], domainPacks, templates);

      expect(manifest.model_routing.haiku).toContain("coder");
      expect(manifest.model_routing.sonnet).not.toContain("coder");
    });
  });

  describe("multi-domain team assembly", () => {
    it("merges agents from multiple active domain packs without duplicates", () => {
      const brief = makeProjectBrief({ domains: ["core", "software", "business"] });

      const softwarePack = makeDomainPack({
        name: "software",
        agents: {
          strategic: ["architect"],
          implementation: ["coder"],
          quality: [],
          utility: ["file-reader"],
        },
      });
      const businessPack = makeDomainPack({
        name: "business",
        agents: {
          strategic: ["project-manager"],
          implementation: ["analyst"],
          quality: [],
          utility: ["file-reader"], // duplicate utility
        },
      });
      const domainPacks = new Map<DomainId, DomainPack>([
        ["software", softwarePack],
        ["business", businessPack],
      ]);

      const manifest = designTeam(
        brief,
        ["software", "business"],
        domainPacks,
        new Map(),
      );

      // Both domains' strategic agents should be present
      expect(manifest.agents.strategic).toContain("architect");
      expect(manifest.agents.strategic).toContain("project-manager");

      // Duplicate utility agent should appear only once
      const fileReaderCount = manifest.agents.utility.filter(
        (a) => a === "file-reader",
      ).length;
      expect(fileReaderCount).toBe(1);
    });

    it("builds cross-domain bridges when multiple domains are active", () => {
      const brief = makeProjectBrief({ domains: ["software", "business"] });

      const softwarePack = makeDomainPack({
        name: "software",
        agents: {
          strategic: ["architect"],
          implementation: ["coder"],
          quality: [],
          utility: [],
        },
      });
      const businessPack = makeDomainPack({
        name: "business",
        agents: {
          strategic: ["project-manager"],
          implementation: ["analyst"],
          quality: [],
          utility: [],
        },
      });
      const domainPacks = new Map<DomainId, DomainPack>([
        ["software", softwarePack],
        ["business", businessPack],
      ]);

      const manifest = designTeam(
        brief,
        ["software", "business"],
        domainPacks,
        new Map(),
      );

      // Delegation graph should have entries for all agents
      expect(Object.keys(manifest.delegation_graph).length).toBeGreaterThan(0);
    });
  });

  describe("delegation graph", () => {
    it("builds a non-empty delegation graph", () => {
      const brief = makeProjectBrief();
      const pack = makeDomainPack({
        name: "software",
        agents: {
          strategic: ["architect"],
          implementation: ["coder"],
          quality: ["test-engineer"],
          utility: ["file-reader"],
        },
      });
      const domainPacks = new Map<DomainId, DomainPack>([["software", pack]]);

      const manifest = designTeam(brief, ["software"], domainPacks, new Map());

      expect(Object.keys(manifest.delegation_graph).length).toBeGreaterThan(0);
    });

    it("strategic agents can delegate to implementation agents in a hierarchy", () => {
      const brief = makeProjectBrief();
      const pack = makeDomainPack({
        name: "software",
        agents: {
          strategic: ["architect"],
          implementation: ["coder"],
          quality: [],
          utility: [],
        },
      });
      const domainPacks = new Map<DomainId, DomainPack>([["software", pack]]);

      const manifest = designTeam(brief, ["software"], domainPacks, new Map());

      // In a hierarchy/flat topology with few agents, architect should be able
      // to reach coder (directly or via the delegation graph)
      const architectDelegates = manifest.delegation_graph["architect"] ?? [];
      expect(architectDelegates).toContain("coder");
    });

    it("all agents appear as keys in the delegation graph", () => {
      const brief = makeProjectBrief();
      const pack = makeDomainPack({
        name: "software",
        agents: {
          strategic: ["architect"],
          implementation: ["coder"],
          quality: ["test-engineer"],
          utility: ["file-reader"],
        },
      });
      const domainPacks = new Map<DomainId, DomainPack>([["software", pack]]);

      const manifest = designTeam(brief, ["software"], domainPacks, new Map());

      const graphKeys = new Set(Object.keys(manifest.delegation_graph));
      expect(graphKeys.has("architect")).toBe(true);
      expect(graphKeys.has("coder")).toBe(true);
      expect(graphKeys.has("test-engineer")).toBe(true);
      expect(graphKeys.has("file-reader")).toBe(true);
    });
  });

  describe("team name", () => {
    it("derives team name from project brief name", () => {
      const brief = makeProjectBrief({
        project: { name: "SuperApp", type: "software", stage: "early" },
      });

      const manifest = designTeam(brief, [], new Map(), new Map());

      expect(manifest.name).toContain("SuperApp");
    });
  });

  describe("empty inputs", () => {
    it("handles empty domainPacks and active domains gracefully", () => {
      const brief = makeProjectBrief();
      const manifest = designTeam(brief, [], new Map(), new Map());

      expect(manifest.agents.strategic).toEqual([]);
      expect(manifest.agents.implementation).toEqual([]);
      expect(manifest.agents.quality).toEqual([]);
      expect(manifest.agents.utility).toEqual([]);
    });

    it("handles empty templates map gracefully", () => {
      const brief = makeProjectBrief();
      const pack = makeDomainPack({
        name: "software",
        agents: { strategic: ["architect"], implementation: [], quality: [], utility: [] },
      });
      const domainPacks = new Map<DomainId, DomainPack>([["software", pack]]);

      // Should not throw even with no templates
      expect(() =>
        designTeam(brief, ["software"], domainPacks, new Map()),
      ).not.toThrow();
    });
  });
});
