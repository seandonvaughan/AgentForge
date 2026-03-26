/**
 * CapabilityInheritance — Sprint 5.1b
 *
 * Skill propagation protocol with compatibility checking and opt-in mechanism.
 * Agents can inherit skills from peers, with proficiency scaling.
 */

export interface AgentSkill {
  skillId: string;
  proficiency: number;       // 0.0–1.0
  exerciseCount: number;
  sourceAgentId?: string;     // set if inherited
}

export interface PropagationResult {
  success: boolean;
  sourceAgentId: string;
  targetAgentId: string;
  skillId: string;
  targetSkillProficiency?: number;
  reason?: string;
  timestamp: string;
}

const MIN_SOURCE_PROFICIENCY = 0.5;
const INHERITANCE_SCALING = 0.6; // inherited skill starts at 60% of source

export class CapabilityInheritance {
  private skills = new Map<string, Map<string, AgentSkill>>(); // agentId → skillId → skill
  private optIns = new Set<string>(); // "agentId::skillId"
  private history: PropagationResult[] = [];

  registerSkill(agentId: string, skill: AgentSkill): void {
    let agentSkills = this.skills.get(agentId);
    if (!agentSkills) {
      agentSkills = new Map();
      this.skills.set(agentId, agentSkills);
    }
    agentSkills.set(skill.skillId, { ...skill });
  }

  getSkills(agentId: string): AgentSkill[] {
    const agentSkills = this.skills.get(agentId);
    if (!agentSkills) return [];
    return Array.from(agentSkills.values()).map((s) => ({ ...s }));
  }

  // ---------------------------------------------------------------------------
  // Opt-in
  // ---------------------------------------------------------------------------

  optIn(agentId: string, skillId: string): void {
    this.optIns.add(`${agentId}::${skillId}`);
  }

  optOut(agentId: string, skillId: string): void {
    this.optIns.delete(`${agentId}::${skillId}`);
  }

  hasOptedIn(agentId: string, skillId: string): boolean {
    return this.optIns.has(`${agentId}::${skillId}`);
  }

  // ---------------------------------------------------------------------------
  // Compatibility
  // ---------------------------------------------------------------------------

  checkCompatibility(sourceAgentId: string, _targetAgentId: string, skillId: string): boolean {
    const sourceSkill = this.skills.get(sourceAgentId)?.get(skillId);
    if (!sourceSkill) return false;
    return sourceSkill.proficiency >= MIN_SOURCE_PROFICIENCY;
  }

  // ---------------------------------------------------------------------------
  // Propagation
  // ---------------------------------------------------------------------------

  propagate(sourceAgentId: string, targetAgentId: string, skillId: string): PropagationResult {
    const now = new Date().toISOString();
    const sourceSkill = this.skills.get(sourceAgentId)?.get(skillId);

    if (!sourceSkill) {
      const result: PropagationResult = {
        success: false, sourceAgentId, targetAgentId, skillId,
        reason: `Source agent "${sourceAgentId}" does not have skill "${skillId}"`,
        timestamp: now,
      };
      this.history.push(result);
      return result;
    }

    if (!this.hasOptedIn(targetAgentId, skillId)) {
      const result: PropagationResult = {
        success: false, sourceAgentId, targetAgentId, skillId,
        reason: `Target agent "${targetAgentId}" has not opted-in for skill "${skillId}"`,
        timestamp: now,
      };
      this.history.push(result);
      return result;
    }

    const inheritedProficiency = sourceSkill.proficiency * INHERITANCE_SCALING;
    const inheritedSkill: AgentSkill = {
      skillId,
      proficiency: inheritedProficiency,
      exerciseCount: 0,
      sourceAgentId,
    };

    let targetSkills = this.skills.get(targetAgentId);
    if (!targetSkills) {
      targetSkills = new Map();
      this.skills.set(targetAgentId, targetSkills);
    }
    targetSkills.set(skillId, inheritedSkill);

    const result: PropagationResult = {
      success: true, sourceAgentId, targetAgentId, skillId,
      targetSkillProficiency: inheritedProficiency,
      timestamp: now,
    };
    this.history.push(result);
    return result;
  }

  getPropagationHistory(): PropagationResult[] {
    return this.history.map((r) => ({ ...r }));
  }
}
