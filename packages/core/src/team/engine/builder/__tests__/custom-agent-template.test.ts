/**
 * v25 — custom-agent template fallback prompt.
 *
 * When a custom specialist has no base template, the forge used to emit a
 * near-blank one-liner system prompt. It must now emit the rich section
 * structure driven by the standard placeholder set so template-customizer
 * fills in real project context.
 */

import { describe, it, expect } from "vitest";
import { buildCustomAgentTemplate } from "../index.js";
import type { AgentTemplate } from "../../types/agent.js";

describe("buildCustomAgentTemplate", () => {
  it("emits the rich placeholder-driven prompt when no base template exists", () => {
    const template = buildCustomAgentTemplate(
      "nonexistent-base",
      "api-specialist",
      "High API surface detected",
      new Map<string, AgentTemplate>(),
      "sonnet",
    );

    expect(template.name).toBe("api-specialist");
    expect(template.model).toBe("sonnet");

    const prompt = template.system_prompt;
    // Rich section structure
    expect(prompt).toContain("## Identity & Mission");
    expect(prompt).toContain("## Owned Subsystems");
    expect(prompt).toContain("## Conventions");
    expect(prompt).toContain("## Key APIs/Patterns");
    expect(prompt).toContain("## Collaboration");
    // Full placeholder set, filled later by customizeTemplate
    expect(prompt).toContain("{project_name}");
    expect(prompt).toContain("{project_purpose}");
    expect(prompt).toContain("{key_subsystems}");
    expect(prompt).toContain("{detected_stack}");
    expect(prompt).toContain("{detected_conventions}");
    expect(prompt).toContain("{baked_learnings}");
    // The seat justification survives
    expect(prompt).toContain("High API surface detected");
  });

  it("clones the base template when one exists (no placeholder fallback)", () => {
    const base: AgentTemplate = {
      name: "coder",
      model: "sonnet",
      version: "1.0",
      description: "base coder",
      system_prompt: "You are the Coder for {project_name}.",
      skills: ["code_generation"],
      triggers: { file_patterns: [], keywords: [] },
      collaboration: {
        reports_to: null,
        reviews_from: [],
        can_delegate_to: [],
        parallel: false,
      },
      context: { max_files: 20, auto_include: [], project_specific: [] },
    };

    const template = buildCustomAgentTemplate(
      "coder",
      "payments-coder",
      "Payments subsystem detected",
      new Map([["coder", base]]),
      "sonnet",
    );

    expect(template.name).toBe("payments-coder");
    expect(template.system_prompt).toBe(base.system_prompt);
    expect(template.description).toContain("based on coder");
    expect(template.collaboration.reports_to).toBe("architect");
  });
});
