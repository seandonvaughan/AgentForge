import type { Entity } from './types.js';

export class NLEntityExtractor {
  extract(input: string): Entity[] {
    const entities: Entity[] = [];

    // Agent names
    const agentNames = [
      'architect', 'coder', 'researcher', 'debugger', 'linter',
      'cto', 'coo', 'genesis', 'meta-architect', 'project-manager',
      'skill-designer', 'team-reviewer', 'template-optimizer',
      'api-specialist', 'db-specialist',
    ];
    const agentPattern = new RegExp(`\\b(${agentNames.join('|')})\\b`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = agentPattern.exec(input)) !== null) {
      const value = match[1];
      if (!value) continue;
      entities.push({
        type: 'agent_name',
        value: value.toLowerCase(),
        raw: match[0],
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    }

    // Version numbers — e.g. "v5.7", "version 5.7", "5.7.0"
    const versionPattern = /\bv?(\d+\.\d+(?:\.\d+)?)\b/g;
    while ((match = versionPattern.exec(input)) !== null) {
      const value = match[1];
      if (!value) continue;
      entities.push({
        type: 'version',
        value,
        raw: match[0],
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    }

    // Cost amounts — e.g. "$5.50", "5 dollars"
    const costPattern = /\$(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:dollars?|usd)/gi;
    while ((match = costPattern.exec(input)) !== null) {
      const value = match[1] ?? match[2];
      if (!value) continue;
      entities.push({
        type: 'cost_amount',
        value,
        raw: match[0],
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    }

    // Sprint versions — e.g. "sprint v5.7", "sprint 5.7"
    const sprintPattern = /\bsprint\s+v?(\d+\.\d+(?:\.\d+)?)\b/gi;
    while ((match = sprintPattern.exec(input)) !== null) {
      const value = match[1];
      if (!value) continue;
      entities.push({
        type: 'sprint_version',
        value,
        raw: match[0],
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    }

    // Workflow names — quoted strings or "X workflow"
    const workflowPattern = /"([^"]+)"\s*workflow|\b(\w+)\s+workflow\b/gi;
    while ((match = workflowPattern.exec(input)) !== null) {
      const value = match[1] ?? match[2];
      if (!value) continue;
      entities.push({
        type: 'workflow_name',
        value,
        raw: match[0],
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    }

    return entities.sort((a, b) => a.startIndex - b.startIndex);
  }
}
